import { insertInsideRangeMessage, overlappingRangeMessage } from "./messages.js";
import type { ApplyResult, EditRange, HashlineOperation } from "./types.js";

interface EditableFile {
  lines: string[];
  hadTrailingNewline: boolean;
}

function splitEditableFile(text: string): EditableFile {
  if (text.length === 0) return { lines: [], hadTrailingNewline: false };
  const lines = text.split("\n");
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (hadTrailingNewline) lines.pop();
  return { lines, hadTrailingNewline };
}

function joinEditableFile(file: EditableFile): string {
  if (file.lines.length === 0) return "";
  return file.lines.join("\n") + (file.hadTrailingNewline ? "\n" : "");
}

function validateAnchoredLine(line: number, totalLines: number, sourceLine: number): void {
  if (line < 1 || line > totalLines) {
    throw new Error(`line ${sourceLine}: line ${line} does not exist in the current file (${totalLines} line${totalLines === 1 ? "" : "s"}).`);
  }
}

function validateRanges(operations: readonly HashlineOperation[], totalLines: number): EditRange[] {
  const ranges: Array<EditRange & { sourceLine: number }> = [];
  for (const operation of operations) {
    if (operation.kind !== "swap" && operation.kind !== "delete") continue;
    validateAnchoredLine(operation.startLine, totalLines, operation.sourceLine);
    validateAnchoredLine(operation.endLine, totalLines, operation.sourceLine);
    ranges.push({ startLine: operation.startLine, endLine: operation.endLine, sourceLine: operation.sourceLine });
  }
  ranges.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1]!;
    const current = ranges[index]!;
    if (current.startLine <= previous.endLine) {
      throw new Error(`line ${current.sourceLine}: ${overlappingRangeMessage(previous.startLine, previous.endLine, current.startLine, current.endLine)}`);
    }
  }
  return ranges;
}

function validateInsertAnchors(operations: readonly HashlineOperation[], totalLines: number, ranges: readonly EditRange[]): void {
  for (const operation of operations) {
    if (operation.kind !== "insert_before" && operation.kind !== "insert_after") continue;
    validateAnchoredLine(operation.anchorLine, totalLines, operation.sourceLine);
    for (const range of ranges) {
      if (operation.anchorLine < range.startLine || operation.anchorLine > range.endLine) continue;
      const boundaryAllowed =
        (operation.kind === "insert_before" && operation.anchorLine === range.startLine) ||
        (operation.kind === "insert_after" && operation.anchorLine === range.endLine);
      if (!boundaryAllowed) {
        throw new Error(
          `line ${operation.sourceLine}: ${insertInsideRangeMessage(
            operation.anchorLine,
            range.startLine,
            range.endLine,
            operation.kind === "insert_before" ? "PRE" : "POST",
          )}`,
        );
      }
    }
  }
}

function validateBodies(operations: readonly HashlineOperation[]): void {
  for (const operation of operations) {
    switch (operation.kind) {
      case "swap":
      case "insert_before":
      case "insert_after":
      case "insert_head":
      case "insert_tail":
        if (operation.lines.length === 0) {
          throw new Error(`line ${operation.sourceLine}: operation body must contain at least one '+' row.`);
        }
        break;
      default:
        break;
    }
  }
}

function firstChangedLine(before: readonly string[], after: readonly string[]): number | undefined {
  const max = Math.max(before.length, after.length);
  for (let index = 0; index < max; index++) {
    if (before[index] !== after[index]) return index + 1;
  }
  return undefined;
}

export function applyOperations(text: string, operations: readonly HashlineOperation[]): ApplyResult {
  if (operations.length === 0) return { text, firstChangedLine: undefined };

  const before = splitEditableFile(text);
  validateBodies(operations);
  const ranges = validateRanges(operations, before.lines.length);
  validateInsertAnchors(operations, before.lines.length, ranges);

  const head: string[] = [];
  const tail: string[] = [];
  const pre = new Map<number, string[]>();
  const post = new Map<number, string[]>();
  const rangesByStart = new Map<number, Extract<HashlineOperation, { kind: "swap" | "delete" }>>();

  for (const operation of operations) {
    switch (operation.kind) {
      case "insert_head":
        head.push(...operation.lines);
        break;
      case "insert_tail":
        tail.push(...operation.lines);
        break;
      case "insert_before": {
        const bucket = pre.get(operation.anchorLine);
        if (bucket) bucket.push(...operation.lines);
        else pre.set(operation.anchorLine, [...operation.lines]);
        break;
      }
      case "insert_after": {
        const bucket = post.get(operation.anchorLine);
        if (bucket) bucket.push(...operation.lines);
        else post.set(operation.anchorLine, [...operation.lines]);
        break;
      }
      case "swap":
      case "delete":
        rangesByStart.set(operation.startLine, operation);
        break;
    }
  }

  const afterLines: string[] = [];
  afterLines.push(...head);

  for (let line = 1; line <= before.lines.length; ) {
    const range = rangesByStart.get(line);
    if (range) {
      const beforeBoundary = pre.get(range.startLine);
      if (beforeBoundary) afterLines.push(...beforeBoundary);
      if (range.kind === "swap") afterLines.push(...range.lines);
      const afterBoundary = post.get(range.endLine);
      if (afterBoundary) afterLines.push(...afterBoundary);
      line = range.endLine + 1;
      continue;
    }

    const preLines = pre.get(line);
    if (preLines) afterLines.push(...preLines);
    afterLines.push(before.lines[line - 1] ?? "");
    const postLines = post.get(line);
    if (postLines) afterLines.push(...postLines);
    line++;
  }

  afterLines.push(...tail);

  const after: EditableFile = { lines: afterLines, hadTrailingNewline: before.hadTrailingNewline };
  const nextText = joinEditableFile(after);
  return {
    text: nextText,
    firstChangedLine: firstChangedLine(before.lines, after.lines),
  };
}
