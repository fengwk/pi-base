import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as Diff from "diff";
import {
  buildCompactDiffPreview,
  InMemorySnapshotStore,
  MismatchError as HashlineMismatchError,
  Patch,
  Patcher,
  type PatchSectionResult,
  type PreparedSection,
} from "./hashline/index.js";
import { PiBaseHashlineFilesystem } from "./hashline-filesystem.js";
import { type NoopLoopGuard, hashPatchInput, recordNoopEdit, resetNoopEdit } from "./hashline-noop-guard.js";
import { canonicalSnapshotKey } from "./hashline-session.js";
import { resolveToolWorkdir, resolveToCwd } from "./path-utils.js";
import {
  type CollapsedResultLinesResolver,
  type CollapsedResultMaxCharsResolver,
  renderCallText,
  renderRawResult,
  resolveCollapsedResultLines,
  resolveCollapsedResultMaxChars,
  shortenHomePath,
  styleAccent,
  styleMuted,
  styleToolTitle,
} from "./render.js";
import { throwIfAborted } from "./runtime.js";
import { editSchema } from "./schemas/edit.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";

const EDIT_ARGUMENT_VALIDATION_HINT = "Hint: Adjust the input parameters and re-run the `edit` command.";
const NOOP_HARD_LIMIT = 3;


function prepareEditArguments(args: unknown, validationTool: any): any {
  try {
    return validateToolArguments(validationTool, {
      type: "toolCall",
      id: "edit-argument-validation",
      name: "edit",
      arguments: args as any,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n\n${EDIT_ARGUMENT_VALIDATION_HINT}`);
  }
}

function resolveToolWorkdirForDisplay(workdir: unknown, cwd?: string): { rawWorkdir: string; usedDefault: boolean } {
  const base = cwd ?? process.cwd();
  if (typeof workdir !== "string" || workdir.trim() === "") return { rawWorkdir: base, usedDefault: true };
  return { rawWorkdir: workdir, usedDefault: false };
}

function formatEditCall(args: any, theme: any, cwd?: string): string {
  const { rawWorkdir, usedDefault } = resolveToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleMuted(theme, " in ")}${styleAccent(theme, shortenHomePath(rawWorkdir))}`;
  const input = String(args?.input ?? "");
  return `${styleToolTitle(theme, "edit")} ${styleMuted(theme, "(hashline patch)")}${workdir}\n\n${input}`;
}

function noChangeDiagnostic(path: string): string {
  return (
    `Edits to ${path} parsed and applied cleanly, but produced no change. ` +
    `Re-read the file and verify both the targeted lines and the replacement body before retrying.`
  );
}

function noChangeLoopDiagnostic(path: string, count: number): string {
  return (
    `STOP. Edits to ${path} have been a byte-identical no-op ${count} times in a row. ` +
    `Do not repeat this same patch. Either the intended change is already on disk, or you are targeting the wrong lines. ` +
    `Read the file again, copy the fresh header, and author a different explicit patch.`
  );
}

function assertUniqueCanonicalPaths(prepared: readonly PreparedSection[]): void {
  const seen = new Map<string, string>();
  for (const entry of prepared) {
    const previous = seen.get(entry.canonicalPath);
    if (previous !== undefined) {
      throw new Error(`Multiple hashline sections resolve to the same file (${previous} and ${entry.section.path}). Use one section header per file.`);
    }
    seen.set(entry.canonicalPath, entry.section.path);
  }
}

function withFileMutationQueues<T>(paths: readonly string[], run: () => Promise<T>): Promise<T> {
  const uniqueSorted = [...new Set(paths)].sort();
  const enter = (index: number): Promise<T> => {
    if (index >= uniqueSorted.length) return run();
    return withFileMutationQueue(uniqueSorted[index]!, () => enter(index + 1));
  };
  return enter(0);
}

function generateNumberedDiff(oldContent: string, newContent: string, contextLines = 4): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const rawLines = part.value.split("\n");
    if (rawLines[rawLines.length - 1] === "") rawLines.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;
      for (const line of rawLines) {
        if (part.added) output.push(`+${newLineNum++}|${line}`);
        else output.push(`-${oldLineNum++}|${line}`);
      }
      lastWasChange = true;
      continue;
    }

    const nextPartIsChange = index < parts.length - 1 && (parts[index + 1]!.added || parts[index + 1]!.removed);
    if (lastWasChange || nextPartIsChange) {
      let linesToShow = rawLines;
      let skipStart = 0;
      let skipEnd = 0;

      if (!lastWasChange) {
        skipStart = Math.max(0, rawLines.length - contextLines);
        linesToShow = rawLines.slice(skipStart);
      }
      if (!nextPartIsChange && linesToShow.length > contextLines) {
        skipEnd = linesToShow.length - contextLines;
        linesToShow = linesToShow.slice(0, contextLines);
      }

      if (skipStart > 0) {
        output.push("...");
        oldLineNum += skipStart;
        newLineNum += skipStart;
      }
      for (const line of linesToShow) {
        output.push(` ${oldLineNum}|${line}`);
        oldLineNum++;
        newLineNum++;
      }
      if (skipEnd > 0) {
        output.push("...");
        oldLineNum += skipEnd;
        newLineNum += skipEnd;
      }
    } else {
      oldLineNum += rawLines.length;
      newLineNum += rawLines.length;
    }
    lastWasChange = false;
  }

  return { diff: output.join("\n"), firstChangedLine };
}

function renderSection(result: PatchSectionResult): { contentText: string; diff: string; firstChangedLine?: number } {
  if (result.op === "noop") return { contentText: noChangeDiagnostic(result.path), diff: "" };
  const numberedDiff = generateNumberedDiff(result.before, result.after);
  const preview = buildCompactDiffPreview(numberedDiff.diff);
  const warningsBlock = result.warnings.length > 0 ? `\n\nWarnings:\n${result.warnings.join("\n")}` : "";
  const previewBlock = preview.preview ? `\n${preview.preview}` : "";
  const diffBlock = numberedDiff.diff.trim() ? `\n\ndiff:\n${numberedDiff.diff}` : "";
  return {
    contentText: `${result.header}${previewBlock}${diffBlock}${warningsBlock}`,
    diff: numberedDiff.diff,
    firstChangedLine: result.firstChangedLine ?? numberedDiff.firstChangedLine,
  };
}

export function registerEditTool(
  pi: ExtensionAPI,
  options: {
    getCollapsedResultLines?: CollapsedResultLinesResolver;
    getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver;
    onSuccessfulEdit?: (absolutePath: string, lines?: string[]) => void;
    snapshots?: InMemorySnapshotStore;
    noopLoopGuard?: NoopLoopGuard;
  } = {},
) {
  const description = loadToolDescription("edit");
  const promptSnippet = loadToolPromptSnippet("edit");
  const validationTool = { name: "edit", description, parameters: editSchema };
  const tool = {
    name: "edit",
    label: "Edit",
    description,
    promptSnippet,
    prepareArguments(args: unknown) {
      return prepareEditArguments(args, validationTool);
    },
    parameters: editSchema,
    renderShell: "default" as const,
    renderCall(args: any, theme: any, context: any) {
      return renderCallText(formatEditCall(args, theme, context?.cwd), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("edit", undefined, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("edit", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(result, { ...renderOptions, collapsedLines, maxCollapsedChars }, theme, context);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      try {
        throwIfAborted(signal);
        const input = String(params.input ?? "");
        if (!input.trim()) throw new Error("input is required.");
        const { cwd } = resolveToolWorkdir(params.workdir, ctx.cwd ?? process.cwd());
        const patch = Patch.parse(input, { cwd });
        const lockedPaths = patch.sections.map((section) => canonicalSnapshotKey(resolveToCwd(section.path, cwd)));
        return await withFileMutationQueues(lockedPaths, async () => {
          const filesystem = new PiBaseHashlineFilesystem({ cwd, signal });
          const patcher = new Patcher({
            fs: filesystem,
            snapshots: options.snapshots ?? new InMemorySnapshotStore(),
          });
          const inputHash = hashPatchInput(input);

          if (patch.sections.length === 1) {
            try {
              const prepared = await patcher.prepare(patch.sections[0]!);
              const sectionResult = await patcher.commit(prepared);
              if (sectionResult.op === "noop") {
                if (options.noopLoopGuard) {
                  const { count, escalate } = recordNoopEdit(options.noopLoopGuard, sectionResult.canonicalPath, inputHash);
                  if (escalate) {
                    return { content: [{ type: "text" as const, text: noChangeLoopDiagnostic(sectionResult.path, count) }], isError: true };
                  }
                }
                return { content: [{ type: "text" as const, text: noChangeDiagnostic(sectionResult.path) }], isError: true };
              }
              if (options.noopLoopGuard) resetNoopEdit(options.noopLoopGuard, sectionResult.canonicalPath);
              options.onSuccessfulEdit?.(filesystem.resolveAbsolute(sectionResult.path), sectionResult.after.length === 0 ? [] : sectionResult.after.split("\n").filter((line, index, lines) => !(index === lines.length - 1 && line === "")));
              const rendered = renderSection(sectionResult);
              return {
                content: [{ type: "text" as const, text: rendered.contentText }],
                details: {
                  diff: rendered.diff,
                  firstChangedLine: rendered.firstChangedLine,
                  path: filesystem.resolveAbsolute(sectionResult.path),
                  oldText: sectionResult.before,
                  newText: sectionResult.after,
                },
              };
            } catch (error) {
              if (error instanceof HashlineMismatchError) {
                return { content: [{ type: "text" as const, text: error.displayMessage }], isError: true };
              }
              throw error;
            }
          }

          const prepared: PreparedSection[] = [];
          try {
            for (const section of patch.sections) prepared.push(await patcher.prepare(section));
            assertUniqueCanonicalPaths(prepared);
          } catch (error) {
            if (error instanceof HashlineMismatchError) {
              return { content: [{ type: "text" as const, text: error.displayMessage }], isError: true };
            }
            throw error;
          }

          for (const entry of prepared) {
            if (!entry.isNoop) continue;
            if (options.noopLoopGuard) {
              const { count, escalate } = recordNoopEdit(options.noopLoopGuard, entry.canonicalPath, inputHash);
              const text = escalate ? noChangeLoopDiagnostic(entry.section.path, count) : noChangeDiagnostic(entry.section.path);
              return { content: [{ type: "text" as const, text }], isError: true };
            }
            return { content: [{ type: "text" as const, text: noChangeDiagnostic(entry.section.path) }], isError: true };
          }

          const sections: string[] = [];
          const diffs: string[] = [];
          let firstChangedLine: number | undefined;
          for (const entry of prepared) {
            const sectionResult = await patcher.commit(entry);
            if (options.noopLoopGuard) resetNoopEdit(options.noopLoopGuard, entry.canonicalPath);
            options.onSuccessfulEdit?.(filesystem.resolveAbsolute(sectionResult.path), sectionResult.after.length === 0 ? [] : sectionResult.after.split("\n").filter((line, index, lines) => !(index === lines.length - 1 && line === "")));
            const rendered = renderSection(sectionResult);
            sections.push(rendered.contentText);
            if (rendered.diff) diffs.push(rendered.diff);
            if (firstChangedLine === undefined) firstChangedLine = rendered.firstChangedLine;
          }

          return {
            content: [{ type: "text" as const, text: sections.join("\n\n") }],
            details: { diff: diffs.join("\n"), firstChangedLine },
          };
        });
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  };
  pi.registerTool(tool as any);
  return tool;
}
