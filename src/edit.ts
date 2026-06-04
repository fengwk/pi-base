import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { Text } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { detectLineEnding, generateCompactOrFullDiff, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.js";
import { applyHashlineEdits, ensureHashInit, escapeControlCharsForDisplay, formatHashlineDisplay, HashlineMismatchError, parseLineRef, splitNewTextLines, type HashlineEditItem } from "./hashline.js";
import { resolveToCwd } from "./path-utils.js";
import { type CollapsedResultLinesResolver, renderRawResult, resolveCollapsedResultLines, styleAccent, styleDiffAdded, styleDiffContext, styleDiffRemoved, styleToolTitle, styleWarning } from "./render.js";
import { editSchema } from "./schemas/edit.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";

const RESULT_CONTEXT_LINES = 2;

function summarizeInsertedText(text: string): string[] {
  const lines = splitNewTextLines(String(text));
  const display = lines.slice(0, 5).map((line) => `+ ${escapeControlCharsForDisplay(visualizeLeadingWhitespace(line))}`);
  if (lines.length > 5) display.push(`+ ... (${lines.length - 5} more lines)`);
  return display;
}

type ResultDiffLine =
  | { kind: "context"; line: number; content: string }
  | { kind: "added"; line: number; content: string }
  | { kind: "removed"; line: number; content: string };

/**
 * Render leading whitespace in a visually distinct form so model and user can
 * tell the difference between "no leading space" and "leading space" at a
 * glance. Trailing whitespace is preserved verbatim.
 */
function visualizeLeadingWhitespace(text: string): string {
  const match = /^[ \t]*/.exec(text);
  if (!match || match[0].length === 0) return text;
  const marker = match[0].replace(/ /g, "·").replace(/\t/g, "→");
  return `${marker}${text.slice(match[0].length)}`;
}

function formatCurrentAnchorLine(lineNumber: number, content: string, width: number): string {
  return formatHashlineDisplay(lineNumber, content, width, escapeControlCharsForDisplay(visualizeLeadingWhitespace(content)));
}

function formatRemovedLine(lineNumber: number, content: string, width: number): string {
  const padded = width > 0 ? String(lineNumber).padStart(width, " ") : String(lineNumber);
  return `${padded}:---|${escapeControlCharsForDisplay(visualizeLeadingWhitespace(content))}`;
}

/**
 * The `Diff.diffLines` library returns each line as a part whose
 * trailing `\n` is part of the value. Splitting the part by `\n`
 * produces `[content, ""]` — the trailing empty is the boundary
 * between this line and the next, not a separate line in the file.
 * Dropping the trailing empty gives 1 part = 1 line, which lets the
 * diff's line numbers match the file's `split("\n")` model.
 */
function partLines(partValue: string): string[] {
  const lines = partValue.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function buildResultDiff(before: string, after: string, contextLines = RESULT_CONTEXT_LINES): string {
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

function formatEditCall(args: any, theme: any): string {
  const path = String(args?.path ?? "<missing-path>");
  const edits = Array.isArray(args?.edits) ? args.edits : [];
  const lines = [`${styleToolTitle(theme, "edit")} ${styleAccent(theme, path)}`];
  if (edits.length === 0) return `${lines[0]}\n\n(no edits)`;
  for (const entry of edits) {
    lines.push("");
    if (entry?.replace_lines) {
      lines.push(styleToolTitle(theme, "replace_lines"));
      lines.push(styleDiffRemoved(theme, `- range ${entry.replace_lines.start_anchor} .. ${entry.replace_lines.end_anchor}`));
      lines.push(...summarizeInsertedText(String(entry.replace_lines.new_text ?? "")).map((line) => styleDiffAdded(theme, line)));
      continue;
    }
    if (entry?.delete_lines) {
      lines.push(styleToolTitle(theme, "delete_lines"));
      lines.push(styleDiffRemoved(theme, `- range ${entry.delete_lines.start_anchor} .. ${entry.delete_lines.end_anchor}`));
      continue;
    }
    if (entry?.insert_before) {
      lines.push(styleToolTitle(theme, "insert_before"));
      lines.push(styleDiffContext(theme, `| before ${entry.insert_before.anchor}`));
      lines.push(...summarizeInsertedText(String(entry.insert_before.new_text ?? "")).map((line) => styleDiffAdded(theme, line)));
      continue;
    }
    if (entry?.insert_after) {
      lines.push(styleToolTitle(theme, "insert_after"));
      lines.push(styleDiffContext(theme, `| after ${entry.insert_after.anchor}`));
      lines.push(...summarizeInsertedText(String(entry.insert_after.new_text ?? "")).map((line) => styleDiffAdded(theme, line)));
      continue;
    }
    lines.push(styleWarning(theme, "? unknown_edit"));
  }
  return lines.join("\n");
}

function safeParseLineRef(ref: string | undefined): { line: number } | undefined {
  if (typeof ref !== "string" || ref.length === 0) return undefined;
  try {
    return { line: parseLineRef(ref).line };
  } catch {
    return undefined;
  }
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
    if (edit?.insert_before) {
      const line = safeParseLineRef(edit.insert_before.anchor)?.line;
      if (line !== undefined) lines.push(line);
      continue;
    }
    if (edit?.insert_after) {
      const line = safeParseLineRef(edit.insert_after.anchor)?.line;
      if (line !== undefined) lines.push(line);
    }
  }
  return lines;
}

function buildNoChangeError(path: string, content: string, edits: any[]): { content: [{ type: "text"; text: string }]; isError: true } {
  const fileLines = content.split("\n");
  const requestedLines = collectRequestedEditLines(edits).filter((line) => line >= 1 && line <= fileLines.length);
  const center = requestedLines.length > 0 ? Math.min(...requestedLines) : 1;
  const radius = 5;
  const start = Math.max(1, center - radius);
  const end = Math.min(fileLines.length, center + radius);
  const context = fileLines.slice(start - 1, end).map((line, index) => formatHashlineDisplay(start + index, line));
  const lines: string[] = [
    `Edit failed for ${path}. The requested edits would not change the file.`,
    "",
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

function buildStaleError(path: string, error: HashlineMismatchError): { content: [{ type: "text"; text: string }]; isError: true } {
  const detail = error.detail;
  const providedAnchor = `${detail.provided.line}:${detail.provided.hash}`;
  const reason = detail.reason === "line_out_of_range"
    ? `line ${detail.provided.line} is outside the current file range 1..${detail.lineCount}`
    : `line ${detail.provided.line} exists, but hash mismatch: provided ${detail.provided.hash}, current ${detail.actual?.hash ?? "<unknown>"}`;
  const actualLine = detail.actual
    ? [`Current line at the provided line number:`, `  ${detail.actual.display}`]
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

export function registerEditTool(
  pi: ExtensionAPI,
  options: {
    wasReadInSession?: (absolutePath: string) => boolean;
    getCollapsedResultLines?: CollapsedResultLinesResolver;
    onSuccessfulEdit?: (absolutePath: string, lines?: string[]) => void;
  } = {},
) {
  const tool = {
    name: "edit",
    label: "Edit",
    description: loadToolDescription("edit"),
    promptSnippet: loadToolPromptSnippet("edit"),
    parameters: editSchema,
    renderShell: "default" as const,
    renderCall(args: any, _theme: any, context: any) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatEditCall(args, _theme));
      return text;
    },
    renderResult(result: any, renderOptions: any, _theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("edit", undefined, context, options.getCollapsedResultLines);
      return renderRawResult(result, { ...renderOptions, collapsedLines }, _theme, context);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      try {
        await ensureHashInit();
        throwIfAborted(signal);
        const rawPath = String(params.path ?? "").replace(/^@/, "");
        if (!rawPath) throw new Error("path is required.");
        if (!Array.isArray(params.edits) || params.edits.length === 0) throw new Error("edits must be a non-empty array.");
        const operationKeys = ["replace_lines", "delete_lines", "insert_before", "insert_after"] as const;
        for (const item of params.edits) {
          const present = operationKeys.filter((key) => item && Object.prototype.hasOwnProperty.call(item, key));
          if (present.length !== 1) {
            throw new Error("Each edit item must contain exactly one operation: `replace_lines`, `delete_lines`, `insert_before`, or `insert_after`.");
          }
        }
        const absolutePath = resolveToCwd(rawPath, ctx.cwd ?? process.cwd());
        if (options.wasReadInSession && !options.wasReadInSession(absolutePath)) {
          return {
            content: [{ type: "text" as const, text: `Edit failed for ${rawPath}. Fresh anchors are required before editing this file. Start with read, write, or a prior edit result for the same region.` }],
            isError: true,
          };
        }

        return withFileMutationQueue(absolutePath, async () => {
          throwIfAborted(signal);
          const raw = await throwIfAbortedAfter(readFile(absolutePath, "utf8"), signal);
          const { bom, text } = stripBom(raw);
          const originalEnding = detectLineEnding(text);
          if (originalEnding === "mixed") {
            return {
              content: [{ type: "text" as const, text: `Edit failed for ${rawPath}. Mixed line endings are not supported. Normalize the file to a single line ending style before editing.` }],
              isError: true,
            };
          }
          const original = normalizeToLF(text);
          let next;
          try {
            next = applyHashlineEdits(original, params.edits as HashlineEditItem[], signal);
          } catch (error) {
            if (error instanceof HashlineMismatchError) return buildStaleError(rawPath, error);
            return { content: [{ type: "text" as const, text: `Edit failed for ${rawPath}. ${(error as Error).message}` }], isError: true };
          }

          if (next.content === original) {
            return buildNoChangeError(rawPath, original, params.edits);
          }

          const writeContent = bom + restoreLineEndings(next.content, originalEnding);
          throwIfAborted(signal);
          await throwIfAbortedAfter(writeFile(absolutePath, writeContent, "utf8"), signal);
          const nextLines = next.content.split("\n");
          options.onSuccessfulEdit?.(absolutePath, nextLines);

          const diffText = buildResultDiff(original, next.content);
          const diff = generateCompactOrFullDiff(original, next.content).diff;

          return {
            content: [{ type: "text" as const, text: `Edit applied to ${rawPath}.\nReview the diff below. Use only LINE:HASH anchors from lines prefixed with \"+\" or \"|\" for follow-up edits in this region; lines prefixed with \"-\" are old/deleted content and intentionally do not carry reusable anchors.\n\n${diffText}` }],
            details: { diff },
          };
        });
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Edit failed. ${(error as Error).message}` }], isError: true };
      }
    },
  };
  pi.registerTool(tool as any);
  return tool;
}
