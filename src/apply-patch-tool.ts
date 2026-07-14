import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as Diff from "diff";
import {
  ApplyPatchCommitError,
  executeApplyPatch,
  parseApplyPatch,
  type ApplyPatchCommitFailure,
  type ApplyPatchFileResult,
  type ApplyPatchOperation,
  type ParsedApplyPatch,
} from "./apply-patch-core.js";
import {
  applyPatchOperationLabel,
  buildApplyPatchPreview,
  buildRawApplyPatchPreview,
  type ApplyPatchPreviewLine,
} from "./apply-patch-display.js";
import { normalizeToLF } from "./line-endings.js";
import { describeToolWorkdirForDisplay } from "./path-utils.js";
import {
  renderRawResult,
  renderStreamingCallText,
  resolveCollapsedResultLines,
  resolveCollapsedResultMaxChars,
  shortenHomePath,
  styleAccent,
  styleDiffAdded,
  styleDiffContext,
  styleDiffRemoved,
  styleMuted,
  styleToolTitle,
  type CollapsedResultLinesResolver,
  type CollapsedResultMaxCharsResolver,
} from "./render.js";
import { applyPatchSchema } from "./schemas/apply-patch.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";
import { withPiBaseErrorMarker } from "./tool-error-marker.js";

export interface ApplyPatchFileMetadata {
  operation: ApplyPatchOperation;
  path: string;
  absolutePath: string;
  diff: string;
  addedLines: number;
  removedLines: number;
}

export interface ApplyPatchToolDetails {
  files: ApplyPatchFileMetadata[];
  partial: boolean;
  failedPath?: string;
  failedPathState?: "unknown";
}

const APPLY_PATCH_DIFF_MAX_LINES = 400;
const APPLY_PATCH_DIFF_MAX_LINE_CHARS = 500;

function truncateDisplayDiffLine(line: string): string {
  if (line.length <= APPLY_PATCH_DIFF_MAX_LINE_CHARS) return line;
  return `${line.slice(0, APPLY_PATCH_DIFF_MAX_LINE_CHARS - 3)}...`;
}

function buildDisplayDiff(before: string | null, after: string | null): { diff: string; addedLines: number; removedLines: number } {
  const patch = Diff.structuredPatch(
    "",
    "",
    normalizeToLF(before ?? ""),
    normalizeToLF(after ?? ""),
    undefined,
    undefined,
    { context: 4 },
  );
  let addedLines = 0;
  let removedLines = 0;
  let totalDiffLines = 0;
  const retainedLines: string[] = [];
  const visitLine = (line: string) => {
    totalDiffLines++;
    if (retainedLines.length < APPLY_PATCH_DIFF_MAX_LINES) retainedLines.push(truncateDisplayDiffLine(line));
  };
  for (const hunk of patch.hunks) {
    visitLine(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith("+")) addedLines++;
      else if (line.startsWith("-")) removedLines++;
      visitLine(line);
    }
  }
  if (totalDiffLines > APPLY_PATCH_DIFF_MAX_LINES) {
    const visibleCount = APPLY_PATCH_DIFF_MAX_LINES - 1;
    const omittedLines = totalDiffLines - visibleCount;
    retainedLines.length = visibleCount;
    retainedLines.push(`... (${omittedLines} more diff lines omitted)`);
  }
  return { diff: retainedLines.join("\n"), addedLines, removedLines };
}

export function buildApplyPatchFileMetadata(file: ApplyPatchFileResult): ApplyPatchFileMetadata {
  return {
    operation: file.operation,
    path: file.path,
    absolutePath: file.absolutePath,
    ...buildDisplayDiff(file.before, file.after),
  };
}

const APPLY_PATCH_CALL_MAX_TARGETS = 20;
const APPLY_PATCH_CALL_MAX_TARGET_CHARS = 160;

function truncateCallTarget(target: string): string {
  if (target.length <= APPLY_PATCH_CALL_MAX_TARGET_CHARS) return target;
  return `${target.slice(0, APPLY_PATCH_CALL_MAX_TARGET_CHARS - 3)}...`;
}

function formatCallTargetSummary(patch: ParsedApplyPatch): string {
  const targets = patch.files.slice(0, APPLY_PATCH_CALL_MAX_TARGETS).map((file) => {
    const path = shortenHomePath(file.path);
    const destination = file.operation === "update" && file.moveTo !== undefined
      ? ` -> ${shortenHomePath(file.moveTo)}`
      : "";
    return truncateCallTarget(`${applyPatchOperationLabel(file.operation)} ${path}${destination}`);
  });
  const omitted = patch.files.length - targets.length;
  if (omitted > 0) targets.push(`... (${omitted} more targets)`);
  return targets.join(", ");
}

function colorizePreviewLine(line: ApplyPatchPreviewLine, theme: any): string {
  if (line.kind === "file") {
    const label = applyPatchOperationLabel(line.operation);
    const target = shortenHomePath(line.text.slice(label.length + 1));
    const styledLabel = label === "A"
      ? styleDiffAdded(theme, label)
      : label === "D"
        ? styleDiffRemoved(theme, label)
        : styleAccent(theme, label);
    return `${styledLabel} ${styleAccent(theme, target)}`;
  }
  if (line.kind === "add") return styleDiffAdded(theme, line.text);
  if (line.kind === "delete") return styleDiffRemoved(theme, line.text);
  if (line.kind === "context") return styleDiffContext(theme, line.text);
  if (line.kind === "blank") return "";
  return line.text.startsWith("@@") ? styleDiffContext(theme, line.text) : styleMuted(theme, line.text);
}

export function formatApplyPatchCall(args: any, theme: any, cwd?: string): string {
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleMuted(theme, " in ")}${styleAccent(theme, shortenHomePath(rawWorkdir))}`;
  const header = `${styleToolTitle(theme, "apply_patch")}${workdir}`;
  if (typeof args?.patchText !== "string" || args.patchText.length === 0) return header;
  try {
    const patch = parseApplyPatch(args.patchText);
    const targets = formatCallTargetSummary(patch);
    const preview = buildApplyPatchPreview(patch, { maxLines: 40, maxLineChars: 240 });
    return [
      header,
      `${styleMuted(theme, "Targets: ")}${styleAccent(theme, targets)}`,
      preview.lines.map((line) => colorizePreviewLine(line, theme)).join("\n"),
    ].join("\n\n");
  } catch {
    const preview = buildRawApplyPatchPreview(args.patchText, { maxLines: 40, maxLineChars: 240 });
    return `${header}\n\n${preview.lines.map((line) => colorizePreviewLine(line, theme)).join("\n")}`;
  }
}

function formatSummary(files: readonly ApplyPatchFileMetadata[]): string {
  const targets = files.map((file) => `${applyPatchOperationLabel(file.operation)} ${file.path}`).join(", ");
  return `Applied patch successfully (${files.length} ${files.length === 1 ? "file" : "files"}): ${targets}`;
}

function formatPartialError(error: ApplyPatchCommitError, files: readonly ApplyPatchFileMetadata[]): string {
  const failedState = `The state of ${error.failedPath} is unknown because the commit operation failed.`;
  if (files.length === 0) return `Error: Patch failed before any file was committed at ${error.failedPath}. ${failedState} Cause: ${error.causeMessage}`;
  const targets = files.map((file) => `${applyPatchOperationLabel(file.operation)} ${file.path}`).join(", ");
  return `Error: Patch partially applied: ${files.length} ${files.length === 1 ? "file was" : "files were"} committed (${targets}) before failure at ${error.failedPath}. ${failedState} Cause: ${error.causeMessage}`;
}

function renderResultWithDiffMetadata(result: any): any {
  const files = Array.isArray(result?.details?.files) ? result.details.files as ApplyPatchFileMetadata[] : [];
  if (files.length === 0) return result;
  const sections = files.map((file) => {
    const heading = `${applyPatchOperationLabel(file.operation)} ${file.path} (+${file.addedLines} -${file.removedLines})`;
    return file.diff ? `${heading}\ndiff:\n${file.diff}` : heading;
  });
  const summary = result?.content?.find((item: any) => item?.type === "text")?.text ?? "";
  return { ...result, content: [{ type: "text" as const, text: [summary, ...sections].filter(Boolean).join("\n\n") }] };
}

export function registerApplyPatchTool(
  pi: ExtensionAPI,
  options: {
    onCommitted?: (result: ApplyPatchFileResult) => void | Promise<void>;
    onCommitFailed?: (failure: ApplyPatchCommitFailure) => void | Promise<void>;
    getCollapsedResultLines?: CollapsedResultLinesResolver;
    getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver;
  } = {},
) {
  const description = loadToolDescription("apply_patch");
  const validationTool = { name: "apply_patch", description, parameters: applyPatchSchema };
  const tool = {
    name: "apply_patch",
    label: "apply_patch",
    description,
    promptSnippet: loadToolPromptSnippet("apply_patch"),
    parameters: applyPatchSchema,
    prepareArguments(args: unknown) {
      return validateToolArguments(validationTool, {
        type: "toolCall",
        id: "apply-patch-argument-validation",
        name: "apply_patch",
        arguments: args as any,
      });
    },
    renderCall(args: any, theme: any, context: any) {
      return renderStreamingCallText(formatApplyPatchCall(args, theme, context?.cwd), theme, context);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("apply_patch", undefined, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("apply_patch", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(renderResultWithDiffMetadata(result), { ...renderOptions, collapsedLines, maxCollapsedChars }, theme, context);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      try {
        if (!params || typeof params.patchText !== "string") {
          throw new Error("patchText is required and must be a string.");
        }
        if (params.workdir !== undefined && typeof params.workdir !== "string") {
          throw new Error("workdir must be a string when provided.");
        }
        const result = await executeApplyPatch(params.patchText, {
          workdir: params.workdir,
          cwd: ctx.cwd ?? process.cwd(),
          signal,
          onCommitted: options.onCommitted,
          onCommitFailed: options.onCommitFailed,
        });
        const files = result.files.map(buildApplyPatchFileMetadata);
        return {
          content: [{ type: "text" as const, text: formatSummary(files) }],
          details: { files, partial: false } satisfies ApplyPatchToolDetails,
        };
      } catch (error) {
        if (error instanceof ApplyPatchCommitError) {
          const files = error.appliedFiles.map(buildApplyPatchFileMetadata);
          return {
            content: [{ type: "text" as const, text: formatPartialError(error, files) }],
            details: {
              files,
              partial: files.length > 0,
              failedPath: error.failedPath,
              failedPathState: error.failedPathState,
            } satisfies ApplyPatchToolDetails,
            isError: true,
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: { files: [], partial: false } satisfies ApplyPatchToolDetails,
          isError: true,
        };
      }
    },
  };
  const markedTool = withPiBaseErrorMarker(tool);
  pi.registerTool(markedTool as any);
  return markedTool;
}
