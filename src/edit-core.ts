import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as Diff from "diff";
import { readFile, stat, writeFile } from "node:fs/promises";
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
import { assertOriginalBytesRoundTrip, decodeTextFile, detectDeclaredTextEncoding, encodeTextFile } from "./text-codec.js";
import { withPiBaseErrorMarker } from "./tool-error-marker.js";
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
    const { diff } = generateNumberedDiff(oldText, newText);
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

function countDisplayedLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  if (text.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
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

interface ReplacementOccurrence {
  startIndex: number;
  endIndex: number;
  start: DocumentCursor;
  end: DocumentCursor;
  consumedEndings: ConcreteLineEnding[];
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
      // A later replacement on this same line may already have inserted a
      // newline. Keep its current boundary instead of restoring the original.
      replacementEolAfter[index] = document.eolAfter[occurrence.end.lineIndex] ?? null;
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
 * Emit a context block into `output`, applying the unified "head + ... + tail" rule
 * for inter-hunk blocks and the position-aware "single-side" rule for leading or
 * trailing context. The leading/trailing distinction is what makes the result match
 * git's `diff -U<N>`: a trailing context block keeps only its first `contextLines`
 * lines (the ones closest to the preceding hunk), a leading context block keeps
 * only its last `contextLines` lines (the ones closest to the following hunk), and
 * an inter-hunk block keeps `contextLines` lines on each side. Blocks that fit
 * within the merge threshold for their position are emitted verbatim.
 *
 * The caller's cursor is advanced by the full block length so line numbers stay
 * correct even when the middle is elided.
 */
function appendContextBlock(
  output: string[],
  block: string[],
  cursor: { oldLineNum: number; newLineNum: number; lineNumberWidth: number },
  contextLines: number,
  position: "leading" | "inter-hunk" | "trailing",
): void {
  const { lineNumberWidth } = cursor;
  let runningOld = cursor.oldLineNum;
  let runningNew = cursor.newLineNum;
  const emit = (line: string) => {
    output.push(formatDiffLine(" ", runningOld, lineNumberWidth, line));
    runningOld++;
    runningNew++;
  };

  if (position === "inter-hunk") {
    // Two hunks share this block. Short enough that both windows fit back-to-back
    // → emit everything; otherwise keep head + "..." + tail.
    if (block.length <= 2 * contextLines) {
      for (const line of block) emit(line);
    } else {
      for (let i = 0; i < contextLines; i++) emit(block[i]!);
      output.push("...");
      const skipCount = block.length - 2 * contextLines;
      runningOld += skipCount;
      runningNew += skipCount;
      for (let i = block.length - contextLines; i < block.length; i++) emit(block[i]!);
    }
  } else if (position === "trailing") {
    // Only the lines closest to the preceding hunk matter; elide the rest.
    if (block.length <= contextLines) {
      for (const line of block) emit(line);
    } else {
      const shownLines = block.slice(0, contextLines);
      const skippedLines = block.length - shownLines.length;
      for (const line of shownLines) emit(line);
      output.push("...");
      runningOld += skippedLines;
      runningNew += skippedLines;
    }
  } else {
    // leading: only the lines closest to the following hunk matter. The elided
    // head of the block lands first, so the cursor must skip ahead before we
    // start emitting the surviving tail.
    if (block.length <= contextLines) {
      for (const line of block) emit(line);
    } else {
      const skippedLines = block.length - contextLines;
      runningOld += skippedLines;
      runningNew += skippedLines;
      output.push("...");
      for (const line of block.slice(skippedLines)) emit(line);
    }
  }

  cursor.oldLineNum = runningOld;
  cursor.newLineNum = runningNew;
}

/**
 * Generate a display-oriented diff with line numbers and context.
 *
 * Each context block is classified by its position relative to the surrounding
 * hunks (leading, inter-hunk, trailing) and rendered with the rule that matches
 * git's `diff -U<N>`:
 *   - leading: keep the last `contextLines` lines (closest to the following hunk)
 *   - inter-hunk: keep `contextLines` lines on each side
 *   - trailing: keep the first `contextLines` lines (closest to the preceding hunk)
 * Adjacent hunks whose context windows would touch are merged into a single
 * inter-hunk block (no "..." separator) so the output reads as one continuous
 * region around the change.
 */
function generateNumberedDiff(oldContent: string, newContent: string, contextLines = 4): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const lineNumberWidth = Math.max(1, String(Math.max(countDisplayedLines(oldContent), countDisplayedLines(newContent), 1)).length);
  const cursor = { oldLineNum: 1, newLineNum: 1, lineNumberWidth };
  let firstChangedLine: number | undefined;

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const rawLines = part.value.split("\n");
    if (rawLines[rawLines.length - 1] === "") rawLines.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = cursor.newLineNum;
      for (const line of rawLines) {
        if (part.added) {
          output.push(formatDiffLine("+", cursor.newLineNum, lineNumberWidth, line));
          cursor.newLineNum++;
        } else {
          output.push(formatDiffLine("-", cursor.oldLineNum, lineNumberWidth, line));
          cursor.oldLineNum++;
        }
      }
      continue;
    }

    const nextPartIsChange = index < parts.length - 1 && (parts[index + 1]!.added || parts[index + 1]!.removed);
    const prevPartWasChange = index > 0 && (parts[index - 1]!.added || parts[index - 1]!.removed);
    if (!prevPartWasChange && !nextPartIsChange) {
      // File head or tail context that no hunk touches: skip entirely.
      cursor.oldLineNum += rawLines.length;
      cursor.newLineNum += rawLines.length;
      continue;
    }
    const position: "leading" | "inter-hunk" | "trailing" =
      prevPartWasChange && nextPartIsChange ? "inter-hunk"
      : prevPartWasChange ? "trailing"
      : "leading";
    appendContextBlock(output, rawLines, cursor, contextLines, position);
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
          const decodedFile = decodeTextFile(rawBytes);
          if (decodedFile === null) {
            return { kind: "error", text: `Error: ${rawPath} appears to be a binary file. edit supports text files only.` };
          }

          assertOriginalBytesRoundTrip(rawBytes, decodedFile);
          const endingStyle = detectLineEnding(decodedFile.text);
          const originalDocument = parseLineEndingDocument(decodedFile.text);
          const fileText = serializeNormalizedDocument(originalDocument);
          const planned: { occurrence: ReplacementOccurrence; newText: string; editIndex: number }[] = [];
          for (const [editIndex, replacement] of normalizedReplacements.entries()) {
            const occurrences = buildReplacementOccurrences(originalDocument, replacement.oldText);
            if (occurrences.length === 0) {
              return { kind: "error", text: `${replacement.prefix}Could not find old_string in ${rawPath}. It must match exactly, including whitespace and indentation.` };
            }
            if (occurrences.length > 1 && !replacement.replaceAll) {
              return {
                kind: "error",
                text: `${replacement.prefix}Found ${occurrences.length} exact matches for old_string in ${rawPath}. Provide more surrounding context to make the match unique, or set replace_all to true.`,
              };
            }
            if (replacement.replaceAll && hasOverlappingOccurrences(occurrences)) {
              return {
                kind: "error",
                text: `${replacement.prefix}Found overlapping exact matches for old_string in ${rawPath}. replace_all cannot safely apply overlapping replacements; provide a more specific old_string.`,
              };
            }
            for (const occurrence of occurrences) {
              planned.push({ occurrence, newText: replacement.newText, editIndex });
            }
          }

          // All matches refer to the original snapshot. Validate the entire
          // batch before changing anything, then apply from right to left so
          // original coordinates remain valid even for multi-line replacements.
          planned.sort((left, right) => left.occurrence.startIndex - right.occurrence.startIndex);
          for (let index = 1; index < planned.length; index++) {
            const previous = planned[index - 1]!;
            const current = planned[index]!;
            if (current.occurrence.startIndex < previous.occurrence.endIndex) {
              return {
                kind: "error",
                text: `Edit ${previous.editIndex + 1} and Edit ${current.editIndex + 1} overlap in ${rawPath}. Batch edits must match independent, non-overlapping regions of the original file.`,
              };
            }
          }

          let nextDocument = originalDocument;
          for (const { occurrence, newText } of planned.reverse()) {
            nextDocument = applyOccurrenceToDocument(nextDocument, occurrence, newText, endingStyle);
          }

          const replacedText = serializeNormalizedDocument(nextDocument);
          const serializedOutput = serializeLineEndingDocument(nextDocument);
          const outputBytes = encodeTextFile(serializedOutput, decodedFile.encoding, decodedFile.bom);
          if (decodedFile.bom === "none") {
            const declared = detectDeclaredTextEncoding(serializedOutput);
            if (declared && declared !== detectDeclaredTextEncoding(decodedFile.text)
              && !encodeTextFile(serializedOutput, declared, "none").equals(outputBytes)) {
              throw new Error("Changing the encoding declaration requires converting the file. Use write with the complete content instead.");
            }
          }
          if (outputBytes.equals(rawBytes)) {
            return { kind: "error", text: "No changes to apply: edit would not change the file." };
          }

          await writeFile(absolutePath, outputBytes);
          return {
            kind: "success",
            fileText,
            replacedText,
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
        const { diff, firstChangedLine } = generateNumberedDiff(computation.fileText, computation.replacedText);
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
