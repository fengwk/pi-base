import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as Diff from "diff";
import { readFile, writeFile } from "node:fs/promises";
import {
  detectLineEnding,
  normalizeToLF,
  parseLineEndingDocument,
  serializeLineEndingDocument,
  serializeNormalizedDocument,
  type ConcreteLineEnding,
  type LineEndingStyle,
  type ParsedLineEndingDocument,
} from "./line-endings.js";
import { describeToolWorkdirForDisplay, resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import {
  type CollapsedResultLinesResolver,
  type CollapsedResultMaxCharsResolver,
  renderStreamingCallText,
  renderRawResult,
  resolveCollapsedResultLines,
  resolveCollapsedResultMaxChars,
  shortenHomePath,
  styleAccent,
  styleDiffAdded,
  styleDiffRemoved,
  styleMuted,
  styleToolTitle,
} from "./render.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";
import { editSchema } from "./schemas/edit.js";
import { decodeTextFile, encodeTextFile } from "./text-codec.js";
import { withPiBaseErrorMarker } from "./tool-error-marker.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";

const EDIT_ARGUMENT_VALIDATION_HINT = "Hint: Adjust the input parameters and re-run the `edit` command.";

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

function formatEditCall(args: any, theme: any, cwd?: string): string {
  const path = shortenHomePath(String(args?.path ?? "<missing-path>"));
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleMuted(theme, " in ")}${styleAccent(theme, shortenHomePath(rawWorkdir))}`;
  const allMatchesTag = args?.replace_all === true ? " [replace_all]" : "";
  return `${styleToolTitle(theme, "edit")} ${styleAccent(theme, path)}${workdir}${allMatchesTag}`;
}

function formatEditCallPreview(args: any, theme: any): string {
  const oldText = String(args?.old_string ?? "");
  const newText = String(args?.new_string ?? "");
  return formatEditPreview(oldText, newText, theme);
}

function formatEditPreview(oldText: string, newText: string, theme: any): string {
  const oldPreview = previewLines(oldText, "-", (line) => styleDiffRemoved(theme, line));
  const newPreview = previewLines(newText, "+", (line) => styleDiffAdded(theme, line));
  return [...oldPreview, ...newPreview].join("\n");
}

function previewLines(value: string, prefix: "+" | "-", styleLine: (line: string) => string): string[] {
  return normalizeToLF(value).split("\n").map((line) => styleLine(`${prefix}${line}`));
}

function countDisplayedLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  if (text.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function formatDiffLine(prefix: " " | "+" | "-", lineNumber: number, lineNumberWidth: number, line: string): string {
  return `${prefix}${String(lineNumber).padStart(lineNumberWidth, " ")}|${line}`;
}

interface DocumentCursor {
  lineIndex: number;
  column: number;
}

interface ReplacementOccurrence {
  startIndex: number;
  endIndex: number;
  start: DocumentCursor;
  end: DocumentCursor;
  consumedEndings: ConcreteLineEnding[];
  trailingEnding: ConcreteLineEnding | null;
}

type EditComputationResult =
  | { kind: "error"; text: string }
  | {
      kind: "success";
      fileText: string;
      replacedText: string;
      replacements: number;
    };

function hasStringProperty(value: any, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key) && typeof value[key] === "string";
}

function findOccurrenceStarts(content: string, search: string): number[] {
  if (search === "") return [];
  const starts: number[] = [];
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    starts.push(offset);
    offset += 1;
  }
  return starts;
}

function hasOverlappingOccurrences(occurrences: readonly ReplacementOccurrence[]): boolean {
  for (let index = 1; index < occurrences.length; index++) {
    if (occurrences[index]!.startIndex < occurrences[index - 1]!.endIndex) return true;
  }
  return false;
}

function cursorFromNormalizedIndex(document: Pick<ParsedLineEndingDocument, "lines" | "eolAfter">, index: number): DocumentCursor {
  let offset = 0;
  for (let lineIndex = 0; lineIndex < document.lines.length; lineIndex++) {
    const line = document.lines[lineIndex] ?? "";
    if (index <= offset + line.length) {
      return { lineIndex, column: index - offset };
    }
    offset += line.length;
    if (document.eolAfter[lineIndex] !== null) {
      if (index === offset + 1) {
        return { lineIndex: Math.min(lineIndex + 1, document.lines.length - 1), column: 0 };
      }
      offset += 1;
    }
  }
  if (document.lines.length === 0 && index === 0) return { lineIndex: 0, column: 0 };
  const lastLineIndex = Math.max(0, document.lines.length - 1);
  const lastLine = document.lines[lastLineIndex] ?? "";
  if (index === offset) return { lineIndex: lastLineIndex, column: lastLine.length };
  throw new Error("line ending document index is out of range.");
}

function buildReplacementOccurrences(document: ParsedLineEndingDocument, search: string): ReplacementOccurrence[] {
  const normalizedText = serializeNormalizedDocument(document);
  const starts = findOccurrenceStarts(normalizedText, search);
  return starts.map((startIndex) => {
    const endIndex = startIndex + search.length;
    const start = cursorFromNormalizedIndex(document, startIndex);
    const end = cursorFromNormalizedIndex(document, endIndex);
    return {
      startIndex,
      endIndex,
      start,
      end,
      consumedEndings: document.eolAfter.slice(start.lineIndex, end.lineIndex).filter((ending): ending is ConcreteLineEnding => ending !== null),
      trailingEnding: document.eolAfter[end.lineIndex] ?? null,
    };
  });
}

function chooseAmbiguousEnding(): ConcreteLineEnding {
  return "\n";
}

function resolveInsertedEnding(
  style: LineEndingStyle,
  index: number,
  consumedEndings: readonly ConcreteLineEnding[],
): ConcreteLineEnding {
  if (style !== "mixed") return style;
  return consumedEndings[index] ?? chooseAmbiguousEnding();
}

function applyOccurrenceToDocument(
  document: ParsedLineEndingDocument,
  occurrence: ReplacementOccurrence,
  replacement: string,
  style: LineEndingStyle,
): ParsedLineEndingDocument {
  const prefix = (document.lines[occurrence.start.lineIndex] ?? "").slice(0, occurrence.start.column);
  const suffix = (document.lines[occurrence.end.lineIndex] ?? "").slice(occurrence.end.column);
  const replacementDocument = parseLineEndingDocument(replacement);
  const replacementLines = [...replacementDocument.lines];
  const replacementEolAfter = [...replacementDocument.eolAfter];
  const lastReplacementIndex = replacementLines.length - 1;
  replacementLines[0] = `${prefix}${replacementLines[0] ?? ""}`;
  replacementLines[lastReplacementIndex] = `${replacementLines[lastReplacementIndex] ?? ""}${suffix}`;
  for (let index = 0; index < replacementEolAfter.length; index++) {
    if (index === replacementEolAfter.length - 1) {
      replacementEolAfter[index] = occurrence.trailingEnding;
      continue;
    }
    replacementEolAfter[index] = resolveInsertedEnding(style, index, occurrence.consumedEndings);
  }
  return {
    lines: [
      ...document.lines.slice(0, occurrence.start.lineIndex),
      ...replacementLines,
      ...document.lines.slice(occurrence.end.lineIndex + 1),
    ],
    eolAfter: [
      ...document.eolAfter.slice(0, occurrence.start.lineIndex),
      ...replacementEolAfter,
      ...document.eolAfter.slice(occurrence.end.lineIndex + 1),
    ],
    defaultEnding: document.defaultEnding,
  };
}

/**
 * Generate a display-oriented diff with line numbers and context.
 */
function generateNumberedDiff(oldContent: string, newContent: string, contextLines = 4): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const lineNumberWidth = Math.max(1, String(Math.max(countDisplayedLines(oldContent), countDisplayedLines(newContent), 1)).length);
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
        if (part.added) output.push(formatDiffLine("+", newLineNum++, lineNumberWidth, line));
        else output.push(formatDiffLine("-", oldLineNum++, lineNumberWidth, line));
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
        output.push(formatDiffLine(" ", oldLineNum, lineNumberWidth, line));
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

export function registerEditTool(
  pi: ExtensionAPI,
  options: {
    getCollapsedResultLines?: CollapsedResultLinesResolver;
    getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver;
    onSuccessfulEdit?: (absolutePath: string) => void;
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
      const header = formatEditCall(args, theme, context?.cwd);
      const preview = formatEditCallPreview(args, theme);
      return renderStreamingCallText(preview ? `${header}\n\n${preview}` : header, theme, context);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("edit", undefined, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("edit", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(result, { ...renderOptions, collapsedLines, maxCollapsedChars }, theme, context);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      try {
        throwIfAborted(signal);

        const rawPath = String(params.path ?? "").replace(/^@/, "");
        if (!rawPath) throw new Error("path is required.");
        if (!hasStringProperty(params, "old_string")) {
          return { content: [{ type: "text" as const, text: "old_string is required and must be a string." }], isError: true };
        }
        if (!hasStringProperty(params, "new_string")) {
          return { content: [{ type: "text" as const, text: "new_string is required and must be a string." }], isError: true };
        }

        const oldText = params.old_string;
        const newText = params.new_string;
        const applyToAllMatches = params.replace_all === true;

        if (oldText === newText) {
          return { content: [{ type: "text" as const, text: "No changes to apply: old_string and new_string are identical." }], isError: true };
        }
        if (oldText === "") {
          return { content: [{ type: "text" as const, text: "old_string must not be empty. Use write to create or overwrite a file." }], isError: true };
        }
        const normalizedOld = normalizeToLF(oldText);
        const normalizedNew = normalizeToLF(newText);
        if (normalizedOld === normalizedNew) {
          return { content: [{ type: "text" as const, text: "No changes to apply: old_string and new_string are identical after line-ending normalization." }], isError: true };
        }

        const { cwd } = resolveToolWorkdir(params.workdir, ctx.cwd ?? process.cwd());
        const absolutePath = resolveToCwd(rawPath, cwd);

        // Serialize the full read-match-write cycle so concurrent edits/writes on the
        // same file cannot compute from the same stale bytes and clobber each other.
        const computation = await withFileMutationQueue(absolutePath, async (): Promise<EditComputationResult> => {
          throwIfAborted(signal);
          const rawBytes = await throwIfAbortedAfter(readFile(absolutePath), signal);
          const decodedFile = decodeTextFile(rawBytes);
          if (decodedFile === null) {
            return { kind: "error", text: `Error: ${rawPath} appears to be a binary file. edit supports text files only.` };
          }

          const endingStyle = detectLineEnding(decodedFile.text);
          const originalDocument = parseLineEndingDocument(decodedFile.text);
          const fileText = serializeNormalizedDocument(originalDocument);
          const occurrences = buildReplacementOccurrences(originalDocument, normalizedOld);

          if (occurrences.length === 0) {
            return { kind: "error", text: `Could not find old_string in ${rawPath}. It must match exactly, including whitespace and indentation.` };
          }
          if (occurrences.length > 1 && !applyToAllMatches) {
            return {
              kind: "error",
              text: `Found ${occurrences.length} exact matches for old_string in ${rawPath}. Provide more surrounding context to make the match unique, or set replace_all to true.`,
            };
          }
          if (applyToAllMatches && hasOverlappingOccurrences(occurrences)) {
            return {
              kind: "error",
              text: `Found overlapping exact matches for old_string in ${rawPath}. replace_all cannot safely apply overlapping replacements; provide a more specific old_string.`,
            };
          }

          let nextDocument = originalDocument;
          const pendingOccurrences = applyToAllMatches ? [...occurrences] : [occurrences[0]!];
          for (const occurrence of pendingOccurrences.reverse()) {
            nextDocument = applyOccurrenceToDocument(nextDocument, occurrence, normalizedNew, endingStyle);
          }

          const replacedText = serializeNormalizedDocument(nextDocument);
          const serializedOutput = serializeLineEndingDocument(nextDocument);
          const outputBytes = encodeTextFile(serializedOutput, decodedFile.encoding, decodedFile.bom);
          if (outputBytes.equals(rawBytes)) {
            return { kind: "error", text: "No changes to apply: edit would not change the file." };
          }

          await writeFile(absolutePath, outputBytes);
          return {
            kind: "success",
            fileText,
            replacedText,
            replacements: applyToAllMatches ? occurrences.length : 1,
          };
        });
        if (computation.kind === "error") {
          return { content: [{ type: "text" as const, text: computation.text }], isError: true };
        }

        // --- Phase 3: Post-write work (outside the lock) ---
        // At this point the file is written. Don't let abort or callback errors
        // turn a successful edit into an error result.
        try {
          options.onSuccessfulEdit?.(absolutePath);
        } catch {
          // Swallow callback errors — the edit itself succeeded.
        }

        // Generate diff for display.
        const { diff, firstChangedLine } = generateNumberedDiff(computation.fileText, computation.replacedText);
        const replacements = computation.replacements;

        const outputTextResult = diff.trim()
          ? `Edited ${rawPath} successfully.\nReplacements: ${replacements}\n\ndiff:\n${diff}`
          : `Edited ${rawPath} successfully.\nReplacements: ${replacements}`;

        return {
          content: [{ type: "text" as const, text: outputTextResult }],
          details: { diff, firstChangedLine, path: absolutePath, oldText: computation.fileText, newText: computation.replacedText },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    },
  };
  const markedTool = withPiBaseErrorMarker(tool);
  pi.registerTool(markedTool as any);
  return markedTool;
}
