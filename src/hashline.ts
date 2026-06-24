import xxhashWasm from "xxhash-wasm";
import { throwIfAborted } from "./runtime.js";
import type { ConcreteLineEnding, ParsedLineEndingDocument } from "./line-endings.js";

export type HashlineEditItem =
  | { replace_lines: { start_anchor: string; end_anchor: string; new_text: string } }
  | { delete_lines: { start_anchor: string; end_anchor: string } }
  | { insert_before_lines: { anchor: string; new_text: string } }
  | { insert_after_lines: { anchor: string; new_text: string } };

export interface HashlineAnchorLine {
  line: number;
  hash: string;
  anchor: string;
  raw: string;
  display: string;
}

export type AnchorMismatchReason = "line_out_of_range" | "hash_mismatch";

export interface AnchorMismatchDetail {
  /** Original anchor provided by the caller. */
  provided: { line: number; hash: string };
  /** Why validation failed for the provided anchor. */
  reason: AnchorMismatchReason;
  /** Current line at the failed line number when the line exists. */
  actual: HashlineAnchorLine | null;
  /** Current total line count of the target file. */
  lineCount: number;
  /** Fresh context anchors from the current target file. */
  nearby: HashlineAnchorLine[];
}

export class HashlineMismatchError extends Error {
  readonly updatedAnchors: HashlineAnchorLine[];
  readonly detail: AnchorMismatchDetail;

  constructor(detail: AnchorMismatchDetail) {
    super(`Anchor mismatch at ${detail.provided.line}#${detail.provided.hash} (${detail.reason})`);
    this.name = "HashlineMismatchError";
    this.updatedAnchors = detail.nearby;
    this.detail = detail;
  }
}

const HASH_LEN = 4;
const RADIX = 16;
const HASH_MOD = RADIX ** HASH_LEN;
const DICT = Array.from({ length: HASH_MOD }, (_, i) => i.toString(RADIX).padStart(HASH_LEN, "0"));
const DISPLAY_CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

let h32Fn: ((input: string, seed?: number) => number) | null = null;
let initPromise: Promise<void> | null = null;

export async function ensureHashInit(): Promise<void> {
  if (h32Fn) return;
  if (!initPromise) {
    initPromise = xxhashWasm().then((hasher) => {
      h32Fn = hasher.h32;
    });
  }
  await initPromise;
}

function xxh32(input: string): number {
  if (!h32Fn) throw new Error("Hash not initialized — call ensureHashInit() first");
  return h32Fn(input, 0) >>> 0;
}

export function computeLineHash(_lineNumber: number, content: string): string {
  let line = content;
  if (line.endsWith("\r")) line = line.slice(0, -1);
  return DICT[xxh32(line) % HASH_MOD];
}

export function escapeControlCharsForDisplay(text: string): string {
  return text.replace(DISPLAY_CONTROL_CHAR_RE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function formatHashlineDisplay(lineNumber: number, content: string, width = 0, displayOverride?: string): string {
  const padded = width > 0 ? String(lineNumber).padStart(width, " ") : String(lineNumber);
  return `${padded}#${computeLineHash(lineNumber, content)}|${displayOverride ?? escapeControlCharsForDisplay(content)}`;
}

export function suggestAnchorFromDisplayedLine(ref: string): string | undefined {
  const match = String(ref).trim().match(new RegExp(`^(\\d+)#([0-9a-fA-F]{${HASH_LEN}})\\|`));
  if (!match) return undefined;
  const line = Number.parseInt(match[1], 10);
  if (line < 1) return undefined;
  return `${line}#${match[2].toLowerCase()}`;
}

export function parseLineRef(ref: string): { line: number; hash: string } {
  const normalized = String(ref).trim();
  const suggestedAnchor = suggestAnchorFromDisplayedLine(normalized);
  if (suggestedAnchor) {
    throw new Error(`Invalid anchor: received a full displayed line. Use only the LINE#HASH anchor ${JSON.stringify(suggestedAnchor)}; do not include the "|..." line content from read/write/edit output.`);
  }
  const match = normalized.match(new RegExp(`^(\\d+)#([0-9a-fA-F]{${HASH_LEN}})$`));
  if (!match) throw new Error(`Invalid anchor ${JSON.stringify(ref)}. Expected exactly LINE#HASH (for example "12#ab34"). Use only the part before "|" from read/write/edit output.`);
  const line = Number.parseInt(match[1], 10);
  if (line < 1) throw new Error(`Invalid anchor ${JSON.stringify(ref)}. Line must be >= 1.`);
  return { line, hash: match[2].toLowerCase() };
}

/** Normalize caller-provided edit text to the file's internal LF model. */
export function normalizeEditText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u2028/g, "\n")
    .replace(/\u2029/g, "\n")
    .replace(/\u0085/g, "\n");
}
/**
 * Split raw edit text for display while preserving trailing newlines as
 * explicit empty trailing lines. Execution uses normalized logical lines; this
 * helper is only for previews and summaries.
 */
export function splitNewTextLines(text: string): string[] {
  return normalizeEditText(text).split("\n");
}

/**
 * Insert-before payloads conceptually end with the separator that reconnects the
 * inserted block to the anchor line, so previews and execution share the same
 * trailing-LF wrapper.
 */
function normalizeInsertBeforeLinesText(text: string): string {
  const normalized = normalizeEditText(text);
  if (normalized.length === 0) return "\n";
  if (normalized.endsWith("\n")) return normalized;
  return `${normalized}\n`;
}

/**
 * Insert-after payloads conceptually start with the separator that detaches the
 * anchor line from the inserted block, so previews and execution share the same
 * leading-LF wrapper.
 */
function normalizeInsertAfterLinesText(text: string): string {
  const normalized = normalizeEditText(text);
  if (normalized.length === 0) return "\n";
  if (normalized.startsWith("\n")) return normalized;
  return `\n${normalized}`;
}

function parseReplaceLinesText(text: string): string[] {
  return normalizeEditText(text).split("\n");
}

function parseInsertBeforeLines(text: string): string[] {
  return normalizeInsertBeforeLinesText(text).slice(0, -1).split("\n");
}

function parseInsertAfterLines(text: string): string[] {
  return normalizeInsertAfterLinesText(text).slice(1).split("\n");
}

const MISMATCH_CONTEXT_RADIUS = 15;
function buildUpdatedAnchors(lines: string[], lineNumbers: number[]): HashlineAnchorLine[] {
  const unique = [...new Set(lineNumbers)].filter((line) => line >= 1 && line <= lines.length).sort((a, b) => a - b);
  const width = String(Math.max(lines.length, 1)).length;
  return unique.map((line) => {
    const raw = lines[line - 1] ?? "";
    const hash = computeLineHash(line, raw);
    return { line, hash, anchor: `${line}#${hash}`, raw, display: formatHashlineDisplay(line, raw, width) };
  });
}

function buildContextLineNumbers(lines: string[], line: number, reason: AnchorMismatchReason): number[] {
  if (lines.length === 0) return [];
  if (reason === "line_out_of_range") {
    if (line < 1) {
      return Array.from({ length: Math.min(lines.length, MISMATCH_CONTEXT_RADIUS * 2 + 1) }, (_, index) => index + 1);
    }
    const start = Math.max(1, lines.length - MISMATCH_CONTEXT_RADIUS * 2);
    return Array.from({ length: lines.length - start + 1 }, (_, index) => start + index);
  }
  const start = Math.max(1, line - MISMATCH_CONTEXT_RADIUS);
  const end = Math.min(lines.length, line + MISMATCH_CONTEXT_RADIUS);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function buildMismatchError(
  lines: string[],
  ref: { line: number; hash: string },
  reason: AnchorMismatchReason,
): HashlineMismatchError {
  const nearby = buildUpdatedAnchors(lines, buildContextLineNumbers(lines, ref.line, reason));
  const actual = reason === "hash_mismatch" && ref.line >= 1 && ref.line <= lines.length
    ? (nearby.find((entry) => entry.line === ref.line) ?? null)
    : null;
  return new HashlineMismatchError({ provided: ref, reason, actual, nearby, lineCount: lines.length });
}

function validateAnchor(lines: string[], ref: { line: number; hash: string }): void {
  if (ref.line < 1 || ref.line > lines.length) {
    throw buildMismatchError(lines, ref, "line_out_of_range");
  }
  const actual = computeLineHash(ref.line, lines[ref.line - 1] ?? "");
  if (actual !== ref.hash) {
    throw buildMismatchError(lines, ref, "hash_mismatch");
  }
}

function buildLineStarts(content: string, lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

function lineStart(starts: number[], line: number): number {
  return starts[line - 1] ?? 0;
}

function lineEnd(starts: number[], lines: string[], line: number, contentLength: number): number {
  const start = lineStart(starts, line);
  return Math.min(contentLength, start + (lines[line - 1] ?? "").length);
}

type RangeOperation = {
  kind: "replace_lines" | "delete_lines";
  index: number;
  start: number;
  end: number;
  refs: Array<{ line: number; hash: string }>;
  spanStart: number;
  spanEnd: number;
  replacementText: string;
  replacementLines: string[];
};

type PointOperation = {
  kind: "insert_before_lines" | "insert_after_lines";
  index: number;
  line: number;
  refs: Array<{ line: number; hash: string }>;
  offset: number;
  replacementText: string;
  insertedLines: string[];
};

type ParsedOperation = RangeOperation | PointOperation;

type PreparedHashlineOperations = {
  operations: ParsedOperation[];
  firstChangedLine: number | undefined;
};

const isRangeOperation = (operation: ParsedOperation): operation is RangeOperation => operation.kind === "replace_lines" || operation.kind === "delete_lines";

function prepareHashlineOperations(content: string, edits: HashlineEditItem[], signal?: AbortSignal): PreparedHashlineOperations {
  throwIfAborted(signal);
  if (edits.length === 0) return { operations: [], firstChangedLine: undefined };

  const lines = content.split("\n");
  const lineStarts = buildLineStarts(content, lines);

  const operations: ParsedOperation[] = edits.map((edit, index) => {
    if ("replace_lines" in edit) {
      const start = parseLineRef(edit.replace_lines.start_anchor);
      const end = parseLineRef(edit.replace_lines.end_anchor);
      if (start.line > end.line) throw new Error("replace_lines requires start_anchor line <= end_anchor line.");
      const replacementText = normalizeEditText(edit.replace_lines.new_text);
      return {
        kind: "replace_lines",
        index,
        start: start.line,
        end: end.line,
        refs: [start, end],
        spanStart: lineStart(lineStarts, start.line),
        spanEnd: lineEnd(lineStarts, lines, end.line, content.length),
        replacementText,
        replacementLines: replacementText.split("\n"),
      };
    }

    if ("delete_lines" in edit) {
      const start = parseLineRef(edit.delete_lines.start_anchor);
      const end = parseLineRef(edit.delete_lines.end_anchor);
      if (start.line > end.line) throw new Error("delete_lines requires start_anchor line <= end_anchor line.");
      let spanStart = lineStart(lineStarts, start.line);
      let spanEnd: number;
      if (end.line < lines.length) {
        spanEnd = lineStart(lineStarts, end.line + 1);
      } else if (start.line > 1) {
        spanStart = lineEnd(lineStarts, lines, start.line - 1, content.length);
        spanEnd = content.length;
      } else {
        spanEnd = content.length;
      }
      return {
        kind: "delete_lines",
        index,
        start: start.line,
        end: end.line,
        refs: [start, end],
        spanStart,
        spanEnd,
        replacementText: "",
        replacementLines: [],
      };
    }

    if ("insert_before_lines" in edit) {
      const before = parseLineRef(edit.insert_before_lines.anchor);
      const replacementText = normalizeInsertBeforeLinesText(edit.insert_before_lines.new_text);
      return {
        kind: "insert_before_lines",
        index,
        line: before.line,
        refs: [before],
        offset: lineStart(lineStarts, before.line),
        replacementText,
        insertedLines: parseInsertBeforeLines(edit.insert_before_lines.new_text),
      };
    }

    const after = parseLineRef(edit.insert_after_lines.anchor);
    const replacementText = normalizeInsertAfterLinesText(edit.insert_after_lines.new_text);
    return {
      kind: "insert_after_lines",
      index,
      line: after.line,
      refs: [after],
      offset: lineEnd(lineStarts, lines, after.line, content.length),
      replacementText,
      insertedLines: parseInsertAfterLines(edit.insert_after_lines.new_text),
    };
  });

  for (const operation of operations) {
    throwIfAborted(signal);
    for (const ref of operation.refs) validateAnchor(lines, ref);
  }

  const rangeOperations = operations
    .filter(isRangeOperation)
    .sort((a, b) => a.spanStart - b.spanStart || a.spanEnd - b.spanEnd || a.index - b.index);

  for (let index = 1; index < rangeOperations.length; index++) {
    const previous = rangeOperations[index - 1]!;
    const current = rangeOperations[index]!;
    if (current.spanStart < previous.spanEnd) throw new Error("Overlapping replace_lines/delete_lines edits are not allowed.");
  }

  const rangeContainingLine = (line: number): RangeOperation | undefined => rangeOperations.find((operation) => operation.start <= line && line <= operation.end);
  let firstChangedLine: number | undefined;

  for (const operation of operations) {
    throwIfAborted(signal);
    if (isRangeOperation(operation)) {
      firstChangedLine = firstChangedLine === undefined ? operation.start : Math.min(firstChangedLine, operation.start);
      continue;
    }

    const containingRange = rangeContainingLine(operation.line);
    if (containingRange) {
      if (operation.kind === "insert_before_lines" && operation.line !== containingRange.start) {
        throw new Error("insert_before_lines anchor cannot point inside a replace_lines/delete_lines range unless it targets the start line.");
      }
      if (operation.kind === "insert_after_lines" && operation.line !== containingRange.end) {
        throw new Error("insert_after_lines anchor cannot point inside a replace_lines/delete_lines range unless it targets the end line.");
      }
    }

    firstChangedLine = firstChangedLine === undefined ? operation.line : Math.min(firstChangedLine, operation.line);
  }

  return { operations, firstChangedLine };
}

function incomingEnding(document: Pick<ParsedLineEndingDocument, "eolAfter">, line: number): ConcreteLineEnding | null {
  return line > 1 ? (document.eolAfter[line - 2] ?? null) : null;
}

function outgoingEnding(document: Pick<ParsedLineEndingDocument, "eolAfter">, line: number): ConcreteLineEnding | null {
  return document.eolAfter[line - 1] ?? null;
}

function inferReplaceBlockEnding(document: Pick<ParsedLineEndingDocument, "eolAfter" | "defaultEnding">, start: number, end: number): ConcreteLineEnding {
  for (let line = start; line < end; line++) {
    const ending = outgoingEnding(document, line);
    if (ending) return ending;
  }
  return outgoingEnding(document, end) ?? incomingEnding(document, start) ?? document.defaultEnding;
}

function inferInsertBeforeBlockEnding(document: Pick<ParsedLineEndingDocument, "eolAfter" | "defaultEnding">, line: number): ConcreteLineEnding {
  return outgoingEnding(document, line) ?? incomingEnding(document, line) ?? document.defaultEnding;
}

function inferInsertAfterBlockEnding(document: Pick<ParsedLineEndingDocument, "eolAfter" | "defaultEnding">, line: number): ConcreteLineEnding {
  return incomingEnding(document, line) ?? outgoingEnding(document, line) ?? document.defaultEnding;
}

function compareLineEndingOperations(a: ParsedOperation, b: ParsedOperation): number {
  const aLine = isRangeOperation(a) ? a.start : a.line;
  const bLine = isRangeOperation(b) ? b.start : b.line;
  if (aLine !== bLine) return bLine - aLine;
  const rank = (operation: ParsedOperation) => operation.kind === "insert_after_lines" ? 0 : isRangeOperation(operation) ? 1 : 2;
  const rankDiff = rank(a) - rank(b);
  if (rankDiff !== 0) return rankDiff;
  return b.index - a.index;
}

function finalizeLineEndingDocument(lines: string[], eolAfter: Array<ConcreteLineEnding | null>): { lines: string[]; eolAfter: Array<ConcreteLineEnding | null> } {
  if (lines.length === 0) return { lines: [""], eolAfter: [null] };
  if (lines.length !== eolAfter.length) {
    throw new Error("Line ending document is inconsistent after editing.");
  }
  eolAfter[eolAfter.length - 1] = null;
  return { lines, eolAfter };
}

export function applyHashlineEdits(
  content: string,
  edits: HashlineEditItem[],
  signal?: AbortSignal,
): { content: string; firstChangedLine: number | undefined } {
  const { operations, firstChangedLine } = prepareHashlineOperations(content, edits, signal);
  if (operations.length === 0) return { content, firstChangedLine };

  type TextEdit = { start: number; end: number; index: number; placement: "before" | "replace" | "after"; replacementText: string };
  const textEdits: TextEdit[] = operations.map((operation) => {
    if (isRangeOperation(operation)) {
      return { start: operation.spanStart, end: operation.spanEnd, index: operation.index, placement: "replace", replacementText: operation.replacementText };
    }
    return {
      start: operation.offset,
      end: operation.offset,
      index: operation.index,
      placement: operation.kind === "insert_before_lines" ? "before" : "after",
      replacementText: operation.replacementText,
    };
  });

  const byStart = new Map<number, TextEdit[]>();
  for (const textEdit of textEdits) {
    const list = byStart.get(textEdit.start) ?? [];
    list.push(textEdit);
    byStart.set(textEdit.start, list);
  }
  for (const list of byStart.values()) {
    const replacing = list.filter((textEdit) => textEdit.end > textEdit.start);
    if (replacing.length > 1) throw new Error("Overlapping replace_lines/delete_lines edits are not allowed.");
  }

  const orderedStarts = [...byStart.keys()].sort((a, b) => b - a);
  let output = content;
  for (const start of orderedStarts) {
    throwIfAborted(signal);
    const list = byStart.get(start)!.sort((a, b) => a.index - b.index);
    const replacing = list.find((textEdit) => textEdit.end > textEdit.start);
    const before = list.filter((textEdit) => textEdit.end === textEdit.start && textEdit.placement === "before").sort((a, b) => a.index - b.index);
    const after = list.filter((textEdit) => textEdit.end === textEdit.start && textEdit.placement === "after").sort((a, b) => a.index - b.index);
    const end = replacing?.end ?? start;
    const replacementText = replacing
      ? `${before.map((textEdit) => textEdit.replacementText).join("")}${replacing.replacementText}${after.map((textEdit) => textEdit.replacementText).join("")}`
      : list.sort((a, b) => a.index - b.index).map((textEdit) => textEdit.replacementText).join("");
    output = `${output.slice(0, start)}${replacementText}${output.slice(end)}`;
  }

  return { content: output, firstChangedLine };
}

export function applyHashlineLineEndings(
  document: Pick<ParsedLineEndingDocument, "lines" | "eolAfter" | "defaultEnding">,
  edits: HashlineEditItem[],
  signal?: AbortSignal,
): { lines: string[]; eolAfter: Array<ConcreteLineEnding | null> } {
  const { operations } = prepareHashlineOperations(document.lines.join("\n"), edits, signal);
  if (operations.length === 0) return { lines: [...document.lines], eolAfter: [...document.eolAfter] };

  const currentLines = [...document.lines];
  const currentEolAfter = [...document.eolAfter];
  for (const operation of [...operations].sort(compareLineEndingOperations)) {
    throwIfAborted(signal);
    if (isRangeOperation(operation)) {
      const spliceStart = operation.start - 1;
      const spliceCount = operation.end - operation.start + 1;
      if (operation.kind === "delete_lines") {
        currentLines.splice(spliceStart, spliceCount);
        currentEolAfter.splice(spliceStart, spliceCount);
        if (currentLines.length === 0) {
          currentLines.push("");
          currentEolAfter.push(null);
          continue;
        }
        if (spliceStart > 0 && spliceStart >= currentLines.length) currentEolAfter[spliceStart - 1] = null;
        continue;
      }

      const blockEnding = inferReplaceBlockEnding(document, operation.start, operation.end);
      const trailingEnding = currentEolAfter[operation.end - 1] ?? null;
      const replacementEolAfter = operation.replacementLines.map((_, index) => index === operation.replacementLines.length - 1 ? trailingEnding : blockEnding);
      currentLines.splice(spliceStart, spliceCount, ...operation.replacementLines);
      currentEolAfter.splice(spliceStart, spliceCount, ...replacementEolAfter);
      continue;
    }

    if (operation.kind === "insert_before_lines") {
      const blockEnding = inferInsertBeforeBlockEnding(document, operation.line);
      currentLines.splice(operation.line - 1, 0, ...operation.insertedLines);
      currentEolAfter.splice(operation.line - 1, 0, ...operation.insertedLines.map(() => blockEnding));
      continue;
    }

    const insertIndex = operation.line;
    const blockEnding = inferInsertAfterBlockEnding(document, operation.line);
    const trailingEnding = currentEolAfter[insertIndex - 1] ?? null;
    currentEolAfter[insertIndex - 1] = blockEnding;
    const insertedEolAfter = operation.insertedLines.map((_, index) => index === operation.insertedLines.length - 1 ? trailingEnding : blockEnding);
    currentLines.splice(insertIndex, 0, ...operation.insertedLines);
    currentEolAfter.splice(insertIndex, 0, ...insertedEolAfter);
  }

  return finalizeLineEndingDocument(currentLines, currentEolAfter);
}