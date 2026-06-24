import * as Diff from "diff";
import { formatHashlineDisplay, normalizeEditText, type HashlineMismatchError } from "./hashline.js";
import { formatCurrentAnchorLine, formatRemovedLine, safeParseLineRef } from "./edit-display.js";

const RESULT_CONTEXT_LINES = 2;

type ToolTextErrorResult = { content: [{ type: "text"; text: string }]; isError: true };

type ResultDiffLine =
  | { kind: "context"; line: number; content: string }
  | { kind: "added"; line: number; content: string }
  | { kind: "removed"; line: number; content: string };

/**
 * The `Diff.diffLines` library returns each line as a part whose trailing `\n`
 * is part of the value. Dropping the trailing empty split item preserves the
 * repository's one-array-item-per-line model.
 */
function partLines(partValue: string): string[] {
  const lines = partValue.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function buildResultDiff(before: string, after: string, contextLines = RESULT_CONTEXT_LINES): string {
  if (after === "") return `| ${formatCurrentAnchorLine(1, "", 1)}`;
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const width = String(Math.max(beforeLines.length, afterLines.length, 1)).length;
  const entries: ResultDiffLine[] = [];
  let beforeLine = 1;
  let afterLine = 1;

  for (const part of Diff.diffLines(before, after)) {
    const lines = partLines(part.value);
    if (part.added) {
      for (const content of lines) entries.push({ kind: "added", line: afterLine++, content });
      continue;
    }
    if (part.removed) {
      for (const content of lines) entries.push({ kind: "removed", line: beforeLine++, content });
      continue;
    }
    for (const content of lines) {
      entries.push({ kind: "context", line: afterLine, content });
      beforeLine++;
      afterLine++;
    }
  }

  const changedIndexes = entries.flatMap((entry, index) => (entry.kind === "context" ? [] : [index]));
  if (changedIndexes.length === 0) return `| ${formatCurrentAnchorLine(1, after, width)}`;

  const windows = changedIndexes.map((index) => ({
    start: Math.max(0, index - contextLines),
    end: Math.min(entries.length - 1, index + contextLines),
  }));
  const merged: Array<{ start: number; end: number }> = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (!previous || window.start > previous.end + 1) {
      merged.push(window);
      continue;
    }
    previous.end = Math.max(previous.end, window.end);
  }

  const output: string[] = [];
  merged.forEach((window, index) => {
    if (index > 0 || window.start > 0) output.push("...");
    for (let i = window.start; i <= window.end; i++) {
      const entry = entries[i];
      if (entry.kind === "context") {
        output.push(`| ${formatCurrentAnchorLine(entry.line, entry.content, width)}`);
        continue;
      }
      if (entry.kind === "added") {
        output.push(`+ ${formatCurrentAnchorLine(entry.line, entry.content, width)}`);
        continue;
      }
      output.push(`- ${formatRemovedLine(entry.line, entry.content, width)}`);
    }
  });
  if (merged[merged.length - 1]!.end < entries.length - 1) output.push("...");
  return output.join("\n");
}

function collectRequestedEditLines(edits: any[]): number[] {
  const lines: number[] = [];
  for (const edit of edits) {
    if (edit?.replace_lines) {
      const start = safeParseLineRef(edit.replace_lines.start_anchor)?.line;
      const end = safeParseLineRef(edit.replace_lines.end_anchor)?.line;
      if (start !== undefined) lines.push(start);
      if (end !== undefined) lines.push(end);
      continue;
    }
    if (edit?.delete_lines) {
      const start = safeParseLineRef(edit.delete_lines.start_anchor)?.line;
      const end = safeParseLineRef(edit.delete_lines.end_anchor)?.line;
      if (start !== undefined) lines.push(start);
      if (end !== undefined) lines.push(end);
      continue;
    }
  }
  return lines;
}

export function buildNoChangeError(path: string, content: string, edits: any[]): ToolTextErrorResult {
  const fileLines = content.split("\n");
  const requestedLines = collectRequestedEditLines(edits).filter((line) => line >= 1 && line <= fileLines.length);
  const center = requestedLines.length > 0 ? Math.min(...requestedLines) : 1;
  const radius = 5;
  const start = Math.max(1, center - radius);
  const end = Math.min(fileLines.length, center + radius);
  const context = fileLines.slice(start - 1, end).map((line, index) => formatHashlineDisplay(start + index, line));
  const identityHints: string[] = [];
  for (const edit of edits) {
    const rep = edit?.replace_lines;
    if (!rep) continue;
    const startRef = safeParseLineRef(rep.start_anchor);
    const endRef = safeParseLineRef(rep.end_anchor);
    if (!startRef || !endRef) continue;
    if (startRef.line < 1 || endRef.line > fileLines.length || startRef.line > endRef.line) continue;
    const originalSlice = fileLines.slice(startRef.line - 1, endRef.line).join("\n");
    if (normalizeEditText(rep.new_text) !== originalSlice) continue;
    identityHints.push(
      `Hint: replace_lines at lines ${startRef.line}..${endRef.line} received new_text identical to the current content at the anchor range. ` +
        `Make sure new_text actually differs from the original line(s).`,
    );
  }
  const lines: string[] = [
    `Edit failed for ${path}. The requested edits would not change the file.`,
    ...(identityHints.length > 0 ? [...identityHints, ""] : [""]),
    `Current context in ${path} around line ${center}:`,
    "",
    `path: ${path}`,
    "kind: file",
    "mediaType: text",
    `offset: ${start}`,
    `limit: ${context.length}`,
    `totalLines: ${fileLines.length}`,
    `hasMore: ${end < fileLines.length}`,
  ];
  if (end < fileLines.length) lines.push(`nextOffset: ${end + 1}`);
  lines.push("", ...context);
  return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
}

export function buildStaleError(path: string, error: HashlineMismatchError): ToolTextErrorResult {
  const detail = error.detail;
  const providedAnchor = `${detail.provided.line}#${detail.provided.hash}`;
  const reason = detail.reason === "line_out_of_range"
    ? `line ${detail.provided.line} is outside the current file range 1..${detail.lineCount}`
    : `line ${detail.provided.line} exists, but hash mismatch: provided ${detail.provided.hash}, current ${detail.actual?.hash ?? "<unknown>"}`;
  const actualLine = detail.actual
    ? ["Current line at the provided line number:", `  ${detail.actual.display}`]
    : [];
  const lines: string[] = [
    `Edit failed for ${path}. The anchor no longer matches the current file.`,
    `Failed anchor: ${providedAnchor}`,
    `Reason: ${reason}.`,
    ...actualLine,
  ];
  const context = detail.nearby;
  if (context.length > 0) {
    const contextOffset = context[0]!.line;
    const contextEnd = context[context.length - 1]!.line;
    const contextHasMore = contextEnd < detail.lineCount;
    lines.push("");
    if (detail.reason === "hash_mismatch") {
      lines.push(`Current context in ${path} around line ${detail.provided.line}:`);
    } else if (detail.provided.line < 1) {
      lines.push(`Current head context in ${path}:`);
    } else {
      lines.push(`Current tail context in ${path}:`);
    }
    lines.push("");
    lines.push(`path: ${path}`);
    lines.push("kind: file");
    lines.push("mediaType: text");
    lines.push(`offset: ${contextOffset}`);
    lines.push(`limit: ${context.length}`);
    lines.push(`totalLines: ${detail.lineCount}`);
    lines.push(`hasMore: ${contextHasMore}`);
    if (contextHasMore) lines.push(`nextOffset: ${contextEnd + 1}`);
    lines.push("");
    for (const entry of context) lines.push(entry.display);
  } else {
    lines.push("");
    lines.push(`The file has ${detail.lineCount} lines. Re-read ${path} if you need more context.`);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
  };
}
