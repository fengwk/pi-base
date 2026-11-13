import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as Diff from "diff";
import { readFile, stat } from "node:fs/promises";
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
  renderCallText,
  renderStreamingCallText,
  renderRawResult,
  resolveCollapsedResultLines,
  resolveCollapsedResultMaxChars,
  shortenHomePath,
  styleAccent,
  styleDiffAdded,
  styleDiffContext,
  styleDiffRemoved,
  styleMuted,
  styleToolTitle,
} from "./render.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";
import { editSchema } from "./schemas/edit.js";
import { mapFilePathToPath } from "./tool-arg-aliases.js";
import { type DecodedTextFile, decodeTextFile, encodingForBom, encodeTextFile, formatTextFileError, resolveDeclaredEncoding } from "./text-codec.js";
import { withPiBaseErrorMarker } from "./tool-error-marker.js";
import { writeFileAtomic } from "./atomic-write.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";

const EDIT_ARGUMENT_VALIDATION_HINT = "Hint: Adjust the input parameters and re-run the `edit` command.";

interface EditRenderState {
  completedDiff: string | undefined;
  completedKey: string | undefined;
}

interface EditReplacement {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function readEditReplacements(params: any): EditReplacement[] {
  if (["old_string", "new_string", "replace_all"].some((key) => Object.prototype.hasOwnProperty.call(params ?? {}, key))) {
    throw new Error("Put old_string, new_string and replace_all inside edits entries, not at the top level.");
  }
  if (!Array.isArray(params?.edits) || params.edits.length === 0) {
    throw new Error("edits must be a non-empty array of replacements; use one entry for a single change.");
  }
  for (let index = 0; index < params.edits.length; index++) {
    const replacement = params.edits[index];
    const prefix = `Edit ${index + 1}: `;
    for (const key of ["old_string", "new_string"]) {
      if (!hasStringProperty(replacement, key)) throw new Error(`${prefix}${key} is required and must be a string.`);
    }
    if (replacement.replace_all !== undefined && typeof replacement.replace_all !== "boolean") {
      throw new Error(`${prefix}replace_all must be a boolean.`);
    }
  }
  return params.edits;
}

function prepareEditArguments(args: unknown, validationTool: any): any {
  try {
    const prepared = validateToolArguments(validationTool, {
      type: "toolCall",
      id: "edit-argument-validation",
      name: "edit",
      arguments: mapFilePathToPath(args) as any,
    });
    readEditReplacements(prepared);
    return prepared;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = message.startsWith("Validation failed for tool") ? "" : 'Validation failed for tool "edit": ';
    throw new Error(`${prefix}${message}\n\n${EDIT_ARGUMENT_VALIDATION_HINT}`);
  }
}

function formatEditCall(args: any, theme: any, cwd?: string): string {
  const path = shortenHomePath(String(args?.path ?? "<missing-path>"));
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleMuted(theme, " in ")}${styleAccent(theme, shortenHomePath(rawWorkdir))}`;
  const allMatchesTag = args?.replace_all === true ? " [replace_all]" : "";
  const batchTag = Array.isArray(args?.edits) ? ` [${args.edits.length} edit${args.edits.length === 1 ? "" : "s"}]` : "";
  return `${styleToolTitle(theme, "edit")} ${styleAccent(theme, path)}${workdir}${allMatchesTag}${batchTag}`;
}

function formatEditCallPreview(args: any, theme: any): string {
  if (Array.isArray(args?.edits)) {
    return args.edits.map((entry: any, index: number) => {
      const preview = formatReplacementPreview(entry, theme);
      return preview ? `${styleMuted(theme, `Edit ${index + 1}${entry?.replace_all === true ? " [replace_all]" : ""}`)}\n${preview}` : "";
    }).filter(Boolean).join("\n\n");
  }
  // Render archived single-style calls, but do not accept them for execution.
  return formatReplacementPreview(args, theme);
}

function formatReplacementPreview(args: any, theme: any): string {
  const oldText = String(args?.old_string ?? "");
  const newText = String(args?.new_string ?? "");
  if (!oldText && !newText) return "";
  try {
    const oldDocument = parseLineEndingDocument(normalizeToLF(oldText));
    const newDocument = parseLineEndingDocument(normalizeToLF(newText));
    const { diff } = generateNumberedDiff(oldDocument, newDocument, [
      { oldStart: 0, oldEnd: oldDocument.lines.length, newStart: 0, newEnd: newDocument.lines.length },
    ]);
    if (!diff.trim()) return "";
    return colorizeCompletedEditDiff(diff, theme);
  } catch {
    // Fall back to the raw preview if the diff generator fails for any reason.
    return formatEditPreview(oldText, newText, theme);
  }
}

function formatEditPreview(oldText: string, newText: string, theme: any): string {
  const oldPreview = previewLines(oldText, "-", (line) => styleDiffRemoved(theme, line));
  const newPreview = previewLines(newText, "+", (line) => styleDiffAdded(theme, line));
  return [...oldPreview, ...newPreview].join("\n");
}

function previewLines(value: string, prefix: "+" | "-", styleLine: (line: string) => string): string[] {
  return normalizeToLF(value).split("\n").map((line) => styleLine(`${prefix}${line}`));
}

function getEditRenderState(context: any): EditRenderState {
  const sharedState = context && typeof context === "object"
    ? (context.state ??= {})
    : {};
  const state = sharedState.__piBaseEditRenderState as EditRenderState | undefined;
  if (state) return state;

  const nextState: EditRenderState = {
    completedDiff: undefined,
    completedKey: undefined,
  };
  sharedState.__piBaseEditRenderState = nextState;
  return nextState;
}

function colorizeCompletedEditDiff(diff: string, theme: any): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return styleDiffAdded(theme, line);
      if (line.startsWith("-")) return styleDiffRemoved(theme, line);
      if (line === "...") return styleMuted(theme, line);
      return styleDiffContext(theme, line);
    })
    .join("\n");
}

function formatCompletedEditCall(header: string, diff: string | undefined, theme: any): string {
  if (!diff?.trim()) return header;
  return `${header}\n\n${colorizeCompletedEditDiff(diff, theme)}`;
}

function formatSuccessfulEditResult(context: any, replacements: number, diff: string): string {
  const rawPath = String(context?.args?.path ?? "<unknown-path>");
  return diff.trim()
    ? `Edited ${rawPath} successfully.\nReplacements: ${replacements}\n\ndiff:\n${diff}`
    : `Edited ${rawPath} successfully.\nReplacements: ${replacements}`;
}

function formatDiffLine(prefix: " " | "+" | "-", lineNumber: number, lineNumberWidth: number, line: string): string {
  return `${prefix}${String(lineNumber).padStart(lineNumberWidth, " ")}|${line}`;
}

interface DocumentCursor {
  lineIndex: number;
  column: number;
}

interface ReplacementSpan {
  startIndex: number;
  endIndex: number;
  start: DocumentCursor;
  end: DocumentCursor;
  consumedEndings: ConcreteLineEnding[];
  editIndex: number;
}

interface AppliedEdit {
  span: ReplacementSpan;
  newText: string;
}

interface ChangeRegion {
  /** Old-document line range, end exclusive. */
  oldStart: number;
  oldEnd: number;
  /** New-document line range, end exclusive. */
  newStart: number;
  newEnd: number;
}

type EditComputationResult =
  | { kind: "error"; text: string }
  | {
      kind: "success";
      oldDocument: ParsedLineEndingDocument;
      newDocument: ParsedLineEndingDocument;
      changes: ChangeRegion[];
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

function hasOverlappingOccurrences(occurrences: readonly Pick<ReplacementSpan, "startIndex" | "endIndex">[]): boolean {
  for (let index = 1; index < occurrences.length; index++) {
    if (occurrences[index]!.startIndex < occurrences[index - 1]!.endIndex) return true;
  }
  return false;
}

/** Normalized index at which every line starts, so span boundaries map by binary search. */
function normalizedLineStarts(document: ParsedLineEndingDocument): number[] {
  const starts: number[] = new Array(document.lines.length);
  let offset = 0;
  for (let lineIndex = 0; lineIndex < document.lines.length; lineIndex++) {
    starts[lineIndex] = offset;
    offset += (document.lines[lineIndex] ?? "").length + (document.eolAfter[lineIndex] === null ? 0 : 1);
  }
  return starts;
}

function cursorAtLineStarts(starts: readonly number[], index: number): DocumentCursor {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= index) low = middle;
    else high = middle - 1;
  }
  return { lineIndex: low, column: index - starts[low]! };
}

function isConcreteEnding(ending: ConcreteLineEnding | null): ending is ConcreteLineEnding {
  return ending !== null;
}

function buildReplacementSpans(
  document: ParsedLineEndingDocument,
  normalizedText: string,
  lineStarts: readonly number[],
  search: string,
  editIndex: number,
): ReplacementSpan[] {
  return findOccurrenceStarts(normalizedText, search).map((startIndex) => {
    const endIndex = startIndex + search.length;
    const start = cursorAtLineStarts(lineStarts, startIndex);
    const end = cursorAtLineStarts(lineStarts, endIndex);
    return {
      startIndex,
      endIndex,
      start,
      end,
      consumedEndings: document.eolAfter.slice(start.lineIndex, end.lineIndex).filter(isConcreteEnding),
      editIndex,
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

/**
 * Applies sorted, non-overlapping spans in a single forward pass: unchanged text
 * is copied verbatim (so untouched lines keep their own endings) and the cost is
 * linear in the document size instead of one full document rebuild per match.
 */
function buildEditedDocument(
  document: ParsedLineEndingDocument,
  edits: readonly AppliedEdit[],
  style: LineEndingStyle,
): ParsedLineEndingDocument {
  const lines: string[] = [];
  const eolAfter: Array<ConcreteLineEnding | null> = [];
  let pending = "";
  let lineIndex = 0;
  let column = 0;
  const endLine = (ending: ConcreteLineEnding | null) => {
    lines.push(pending);
    eolAfter.push(ending);
    pending = "";
  };

  for (const edit of edits) {
    while (lineIndex < edit.span.start.lineIndex) {
      pending += (document.lines[lineIndex] ?? "").slice(column);
      endLine(document.eolAfter[lineIndex] ?? null);
      lineIndex++;
      column = 0;
    }
    pending += (document.lines[lineIndex] ?? "").slice(column, edit.span.start.column);
    const replacement = parseLineEndingDocument(edit.newText);
    pending += replacement.lines[0] ?? "";
    for (let index = 0; index < replacement.lines.length - 1; index++) {
      endLine(resolveInsertedEnding(style, index, edit.span.consumedEndings));
      pending = replacement.lines[index + 1] ?? "";
    }
    // The text after the span is copied next, so the replacement's last line
    // inherits the original ending that follows the replaced text.
    lineIndex = edit.span.end.lineIndex;
    column = edit.span.end.column;
  }

  while (lineIndex < document.lines.length) {
    pending += (document.lines[lineIndex] ?? "").slice(column);
    endLine(document.eolAfter[lineIndex] ?? null);
    lineIndex++;
    column = 0;
  }
  return { lines, eolAfter, defaultEnding: document.defaultEnding };
}

/** Changed line ranges of the applied spans, in both document coordinates. */
function buildChangeRegions(edits: readonly AppliedEdit[]): ChangeRegion[] {
  const regions: ChangeRegion[] = [];
  let lineDelta = 0;
  for (const edit of edits) {
    const oldStart = edit.span.start.lineIndex;
    const oldEnd = edit.span.end.lineIndex + 1;
    const newStart = oldStart + lineDelta;
    const replacementLines = parseLineEndingDocument(edit.newText).lines.length;
    const region = { oldStart, oldEnd, newStart, newEnd: newStart + replacementLines };
    const previous = regions[regions.length - 1];
    if (previous && region.oldStart < previous.oldEnd) {
      previous.oldEnd = Math.max(previous.oldEnd, region.oldEnd);
      previous.newEnd = Math.max(previous.newEnd, region.newEnd);
    } else {
      regions.push(region);
    }
    lineDelta += replacementLines - (oldEnd - oldStart);
  }
  return regions;
}

function displayedLineCount(document: ParsedLineEndingDocument): number {
  const lastLineIndex = document.lines.length - 1;
  // A final newline produces a phantom empty line that read never numbers.
  if (lastLineIndex > 0 && document.lines[lastLineIndex] === "" && document.eolAfter[lastLineIndex] === null) {
    return lastLineIndex;
  }
  return document.lines.length;
}

/**
 * Generate a display-oriented diff from the changed line ranges only, so its cost
 * scales with the change instead of the whole file.
 *
 * Context follows git's `diff -U<N>` for the block's position: a leading block
 * keeps its last `contextLines` lines, a trailing block its first
 * `contextLines`, and an inter-hunk block `contextLines` on each side; a block
 * short enough to fit both windows is shown whole.
 */
function generateNumberedDiff(
  oldDocument: ParsedLineEndingDocument,
  newDocument: ParsedLineEndingDocument,
  changes: readonly ChangeRegion[],
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const output: string[] = [];
  const lineNumberWidth = Math.max(1, String(Math.max(displayedLineCount(oldDocument), displayedLineCount(newDocument), 1)).length);
  let firstChangedLine: number | undefined;
  let previousOldEnd = 0;

  const emitContext = (from: number, count: number) => {
    for (let offset = 0; offset < count; offset++) {
      const oldLineIndex = from + offset;
      output.push(formatDiffLine(" ", oldLineIndex + 1, lineNumberWidth, oldDocument.lines[oldLineIndex] ?? ""));
    }
  };

  for (const [regionIndex, region] of changes.entries()) {
    const gap = region.oldStart - previousOldEnd;
    if (gap > 0) {
      if (regionIndex === 0) {
        if (gap <= contextLines) emitContext(previousOldEnd, gap);
        else {
          output.push("...");
          emitContext(region.oldStart - contextLines, contextLines);
        }
      } else if (gap <= 2 * contextLines) {
        emitContext(previousOldEnd, gap);
      } else {
        emitContext(previousOldEnd, contextLines);
        output.push("...");
        emitContext(region.oldStart - contextLines, contextLines);
      }
    }

    firstChangedLine ??= region.newStart + 1;
    const oldLines = oldDocument.lines.slice(region.oldStart, region.oldEnd).join("\n");
    const newLines = newDocument.lines.slice(region.newStart, region.newEnd).join("\n");
    let oldLineNumber = region.oldStart + 1;
    let newLineNumber = region.newStart + 1;
    for (const part of Diff.diffLines(oldLines, newLines)) {
      const partLines = part.value.split("\n");
      if (partLines[partLines.length - 1] === "") partLines.pop();
      for (const line of partLines) {
        if (part.added) {
          output.push(formatDiffLine("+", newLineNumber++, lineNumberWidth, line));
        } else if (part.removed) {
          output.push(formatDiffLine("-", oldLineNumber++, lineNumberWidth, line));
        } else {
          output.push(formatDiffLine(" ", oldLineNumber++, lineNumberWidth, line));
          newLineNumber++;
        }
      }
    }
    previousOldEnd = region.oldEnd;
  }

  const trailing = displayedLineCount(oldDocument) - previousOldEnd;
  if (trailing > 0) {
    if (trailing <= contextLines) {
      emitContext(previousOldEnd, trailing);
    } else {
      emitContext(previousOldEnd, contextLines);
      output.push("...");
    }
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
      const mappedArgs = mapFilePathToPath(args);
      const header = formatEditCall(mappedArgs, theme, context?.cwd);
      const state = getEditRenderState(context);
      if (state.completedKey !== undefined) {
        return renderCallText(formatCompletedEditCall(header, state.completedDiff, theme), context?.lastComponent);
      }
      const preview = formatEditCallPreview(mappedArgs, theme);
      return renderStreamingCallText(preview ? `${header}\n\n${preview}` : header, theme, context);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const state = getEditRenderState(context);
      if (!context?.isError) {
        const diff = typeof result?.details?.diff === "string" ? result.details.diff : undefined;
        const replacements = typeof result?.details?.replacements === "number" ? result.details.replacements : undefined;
        const completedKey = JSON.stringify([context?.args?.path ?? "", replacements ?? -1, diff ?? ""]);
        if (state.completedKey !== completedKey) {
          state.completedKey = completedKey;
          state.completedDiff = diff;
          queueMicrotask(() => context?.invalidate?.());
        }
        if (typeof replacements === "number") {
          result = { ...result, content: [{ type: "text" as const, text: formatSuccessfulEditResult(context, replacements, diff ?? "") }] };
        }
      } else {
        state.completedKey = undefined;
        state.completedDiff = undefined;
      }
      const collapsedLines = resolveCollapsedResultLines("edit", undefined, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("edit", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(result, { ...renderOptions, collapsedLines, maxCollapsedChars }, theme, context);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      try {
        throwIfAborted(signal);

        const rawPath = String(params.path ?? "").replace(/^@/, "");
        if (!rawPath) throw new Error("path is required.");
        const requestedReplacements = readEditReplacements(params);
        const normalizedReplacements = requestedReplacements.map((replacement, index) => {
          const prefix = `Edit ${index + 1}: `;
          if (replacement.old_string === replacement.new_string) {
            throw new Error(`${prefix}No changes to apply: old_string and new_string are identical.`);
          }
          if (replacement.old_string === "") {
            throw new Error(`${prefix}old_string must not be empty. Use write to create or overwrite a file.`);
          }
          const oldText = normalizeToLF(replacement.old_string);
          const newText = normalizeToLF(replacement.new_string);
          if (oldText === newText) {
            throw new Error(`${prefix}No changes to apply: old_string and new_string are identical after line-ending normalization.`);
          }
          return { oldText, newText, replaceAll: replacement.replace_all === true, prefix };
        });

        const { cwd } = resolveToolWorkdir(params.workdir, ctx.cwd ?? process.cwd());
        const absolutePath = resolveToCwd(rawPath, cwd);

        // Serialize the full read-match-write cycle so concurrent edits/writes on the
        // same file cannot compute from the same stale bytes and clobber each other.
        const computation = await withFileMutationQueue(absolutePath, async (): Promise<EditComputationResult> => {
          throwIfAborted(signal);
          const currentStat = await throwIfAbortedAfter(stat(absolutePath), signal);
          if (!currentStat.isFile()) throw new Error(`${rawPath} is not a regular file. edit supports text files only.`);
          const rawBytes = await throwIfAbortedAfter(readFile(absolutePath), signal);
          let decodedFile: DecodedTextFile;
          try {
            decodedFile = decodeTextFile(rawBytes, absolutePath);
          } catch (error) {
            return { kind: "error", text: `Error: ${formatTextFileError(error, rawPath, "edited")} edit supports text files only.` };
          }

          const endingStyle = detectLineEnding(decodedFile.text);
          const originalDocument = parseLineEndingDocument(decodedFile.text);
          const normalizedText = serializeNormalizedDocument(originalDocument);
          const lineStarts = normalizedLineStarts(originalDocument);
          const planned: AppliedEdit[] = [];
          for (const [editIndex, replacement] of normalizedReplacements.entries()) {
            const spans = buildReplacementSpans(originalDocument, normalizedText, lineStarts, replacement.oldText, editIndex);
            if (spans.length === 0) {
              return { kind: "error", text: `${replacement.prefix}Could not find old_string in ${rawPath}. It must match exactly, including whitespace and indentation.` };
            }
            if (spans.length > 1 && !replacement.replaceAll) {
              return {
                kind: "error",
                text: `${replacement.prefix}Found ${spans.length} exact matches for old_string in ${rawPath}. Provide more surrounding context to make the match unique, or set replace_all to true.`,
              };
            }
            if (replacement.replaceAll && hasOverlappingOccurrences(spans)) {
              return {
                kind: "error",
                text: `${replacement.prefix}Found overlapping exact matches for old_string in ${rawPath}. replace_all cannot safely apply overlapping replacements; provide a more specific old_string.`,
              };
            }
            for (const span of spans) {
              planned.push({ span, newText: replacement.newText });
            }
          }

          // All spans refer to the original snapshot: validate the whole batch,
          // then apply it in one forward pass over the original document.
          planned.sort((left, right) => left.span.startIndex - right.span.startIndex);
          for (let index = 1; index < planned.length; index++) {
            const previous = planned[index - 1]!;
            const current = planned[index]!;
            if (current.span.startIndex < previous.span.endIndex) {
              return {
                kind: "error",
                text: `Edit ${previous.span.editIndex + 1} and Edit ${current.span.editIndex + 1} overlap in ${rawPath}. Batch edits must match independent, non-overlapping regions of the original file.`,
              };
            }
          }

          const nextDocument = buildEditedDocument(originalDocument, planned, endingStyle);
          const serializedOutput = serializeLineEndingDocument(nextDocument);
          const outputBytes = encodeTextFile(serializedOutput, decodedFile.encoding, decodedFile.bom);
          // Edits may move text around but must not silently convert the file.
          let resultEncoding: string;
          try {
            resultEncoding = decodedFile.bom !== "none"
              ? encodingForBom(decodedFile.bom)!.name
              : resolveDeclaredEncoding(serializedOutput, absolutePath, "none")?.name ?? "UTF-8";
          } catch (error) {
            return { kind: "error", text: `Error: ${rawPath}: ${(error as Error).message}` };
          }
          if (resultEncoding !== decodedFile.encoding.name) {
            return {
              kind: "error",
              text: `This change would change the encoding of ${rawPath} from ${decodedFile.encoding.name} to ${resultEncoding}. Use write with the complete content to convert the file.`,
            };
          }
          if (outputBytes.equals(rawBytes)) {
            return { kind: "error", text: "No changes to apply: edit would not change the file." };
          }

          await writeFileAtomic(absolutePath, outputBytes);
          return {
            kind: "success",
            oldDocument: originalDocument,
            newDocument: nextDocument,
            changes: buildChangeRegions(planned),
            replacements: planned.length,
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
        const { diff, firstChangedLine } = generateNumberedDiff(
          computation.oldDocument,
          computation.newDocument,
          computation.changes,
        );
        const replacements = computation.replacements;

        const outputTextResult = diff.trim()
          ? `Edited ${rawPath} successfully.\nReplacements: ${replacements}\n\ndiff:\n${diff}`
          : `Edited ${rawPath} successfully.\nReplacements: ${replacements}`;

        return {
          content: [{ type: "text" as const, text: outputTextResult }],
          details: { diff, firstChangedLine, path: absolutePath, replacements },
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
