import xxhashWasm from "xxhash-wasm";
import { throwIfAborted } from "./runtime.js";

export type HashlineEditItem =
  | { replace_lines: { start_anchor: string; end_anchor: string; new_text: string } }
  | { delete_lines: { start_anchor: string; end_anchor: string } }
  | { insert_before: { anchor: string; new_text: string } }
  | { insert_after: { anchor: string; new_text: string } };

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
    super(`Anchor mismatch at ${detail.provided.line}:${detail.provided.hash} (${detail.reason})`);
    this.name = "HashlineMismatchError";
    this.updatedAnchors = detail.nearby;
    this.detail = detail;
  }
}

const HASH_LEN = 3;
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
  return `${padded}:${computeLineHash(lineNumber, content)}|${displayOverride ?? escapeControlCharsForDisplay(content)}`;
}

export function parseLineRef(ref: string): { line: number; hash: string } {
  const normalized = String(ref).replace(/\|.*$/, "").trim();
  const match = normalized.match(new RegExp(`^(\\d+):([0-9a-fA-F]{${HASH_LEN}})$`));
  if (!match) throw new Error(`Invalid anchor ${JSON.stringify(ref)}. Expected LINE:HASH.`);
  const line = Number.parseInt(match[1], 10);
  if (line < 1) throw new Error(`Invalid anchor ${JSON.stringify(ref)}. Line must be >= 1.`);
  return { line, hash: match[2].toLowerCase() };
}

/**
 * Split raw `new_text` into logical lines the way a text editor would.
 *
 * Rules:
 * - A trailing newline terminates the last line; it does not add an extra
 *   empty line on its own. So `"foo\n"` and `"foo"` both produce `["foo"]`.
 * - An empty `new_text` (`""`) means "one empty line" — it is not the
 *   absence of content. This applies uniformly to `replace_lines`,
 *   `insert_before`, and `insert_after`: a blank line is a line.
 * - To delete lines, use the separate `delete_lines` primitive; that one
 *   has no `new_text` field at all.
 *
 * This helper is shared by execution and preview rendering so the user sees
 * exactly the same `new_text` semantics before and after running an edit.
 */
export function splitNewTextLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmed.split("\n");
}

const MISMATCH_CONTEXT_RADIUS = 15;
function buildUpdatedAnchors(lines: string[], lineNumbers: number[]): HashlineAnchorLine[] {
  const unique = [...new Set(lineNumbers)].filter((line) => line >= 1 && line <= lines.length).sort((a, b) => a - b);
  const width = String(Math.max(lines.length, 1)).length;
  return unique.map((line) => {
    const raw = lines[line - 1] ?? "";
    const hash = computeLineHash(line, raw);
    return { line, hash, anchor: `${line}:${hash}`, raw, display: formatHashlineDisplay(line, raw, width) };
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

export function applyHashlineEdits(
  content: string,
  edits: HashlineEditItem[],
  signal?: AbortSignal,
): { content: string; firstChangedLine: number | undefined } {
  throwIfAborted(signal);
  if (edits.length === 0) return { content, firstChangedLine: undefined };

  const lines = content.split("\n");

  type RangeOperation = {
    kind: "replace_lines" | "delete_lines";
    index: number;
    start: number;
    end: number;
    refs: Array<{ line: number; hash: string }>;
    newLines: string[];
  };

  type PointOperation = {
    kind: "insert_before" | "insert_after";
    index: number;
    line: number;
    refs: Array<{ line: number; hash: string }>;
    newLines: string[];
  };

  const operations: Array<RangeOperation | PointOperation> = edits.map((edit, index) => {
    if ("replace_lines" in edit) {
      const start = parseLineRef(edit.replace_lines.start_anchor);
      const end = parseLineRef(edit.replace_lines.end_anchor);
      if (start.line > end.line) throw new Error("replace_lines requires start_anchor line <= end_anchor line.");
      return { kind: "replace_lines", index, start: start.line, end: end.line, refs: [start, end], newLines: splitNewTextLines(edit.replace_lines.new_text) };
    }
    if ("delete_lines" in edit) {
      const start = parseLineRef(edit.delete_lines.start_anchor);
      const end = parseLineRef(edit.delete_lines.end_anchor);
      if (start.line > end.line) throw new Error("delete_lines requires start_anchor line <= end_anchor line.");
      return { kind: "delete_lines", index, start: start.line, end: end.line, refs: [start, end], newLines: [] };
    }
    if ("insert_before" in edit) {
      const before = parseLineRef(edit.insert_before.anchor);
      return { kind: "insert_before", index, line: before.line, refs: [before], newLines: splitNewTextLines(edit.insert_before.new_text) };
    }
    const after = parseLineRef(edit.insert_after.anchor);
    return { kind: "insert_after", index, line: after.line, refs: [after], newLines: splitNewTextLines(edit.insert_after.new_text) };
  });

  for (const operation of operations) {
    throwIfAborted(signal);
    for (const ref of operation.refs) validateAnchor(lines, ref);
  }

  const rangeOperations = operations
    .filter((operation): operation is RangeOperation => operation.kind === "replace_lines" || operation.kind === "delete_lines")
    .sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);

  for (let i = 1; i < rangeOperations.length; i++) {
    const previous = rangeOperations[i - 1];
    const current = rangeOperations[i];
    if (current.start <= previous.end) throw new Error("Overlapping replace_lines/delete_lines edits are not allowed.");
  }

  const rangeContainingLine = (line: number): RangeOperation | undefined => rangeOperations.find((operation) => operation.start <= line && line <= operation.end);

  const boundaryInsertions = new Map<number, string[][]>();
  const rangeByStart = new Map<number, RangeOperation>();
  let firstChangedLine: number | undefined;

  for (const operation of operations) {
    throwIfAborted(signal);
    if (operation.kind === "replace_lines" || operation.kind === "delete_lines") {
      rangeByStart.set(operation.start, operation);
      firstChangedLine = firstChangedLine === undefined ? operation.start : Math.min(firstChangedLine, operation.start);
      continue;
    }

    const pointOperation = operation as PointOperation;

    const containingRange = rangeContainingLine(pointOperation.line);
    if (containingRange) {
      if (pointOperation.kind === "insert_before" && pointOperation.line !== containingRange.start) {
        throw new Error("insert_before anchor cannot point inside a replace_lines/delete_lines range unless it targets the start line.");
      }
      if (pointOperation.kind === "insert_after" && pointOperation.line !== containingRange.end) {
        throw new Error("insert_after anchor cannot point inside a replace_lines/delete_lines range unless it targets the end line.");
      }
    }

    const boundary = pointOperation.kind === "insert_before" ? pointOperation.line - 1 : pointOperation.line;
    const list = boundaryInsertions.get(boundary) ?? [];
    list.push(pointOperation.newLines);
    boundaryInsertions.set(boundary, list);
    const changedLine = boundary + 1;
    firstChangedLine = firstChangedLine === undefined ? changedLine : Math.min(firstChangedLine, changedLine);
  }

  const output: string[] = [];
  const emitBoundary = (boundary: number) => {
    for (const newLines of boundaryInsertions.get(boundary) ?? []) output.push(...newLines);
  };
  let lineNumber = 1;
  while (lineNumber <= lines.length) {
    throwIfAborted(signal);

    emitBoundary(lineNumber - 1);

    const rangeOperation = rangeByStart.get(lineNumber);
    if (rangeOperation) {
      output.push(...rangeOperation.newLines);
      lineNumber = rangeOperation.end + 1;
      continue;
    }

    output.push(lines[lineNumber - 1] ?? "");
    lineNumber++;
  }

  emitBoundary(lineNumber - 1);

  return { content: output.join("\n"), firstChangedLine };
}
