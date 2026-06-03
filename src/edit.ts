import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { Text } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { detectLineEnding, generateCompactOrFullDiff, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.js";
import { applyHashlineEdits, ensureHashInit, escapeControlCharsForDisplay, formatHashlineDisplay, HashlineMismatchError, parseLineRef, splitNewTextLines, type HashlineEditItem } from "./hashline.js";
import { resolveToCwd } from "./path-utils.js";
import { type CollapsedResultLinesResolver, renderRawResult, resolveCollapsedResultLines, styleAccent, styleDiffAdded, styleDiffContext, styleDiffRemoved, styleMuted, styleToolTitle, styleWarning } from "./render.js";
import { editSchema } from "./schemas/edit.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";

const RESULT_CONTEXT_LINES = 2;
const CALL_CONTEXT_LINES = 1;
const MAX_EDIT_CALL_PREVIEW_SNAPSHOTS = 100;
const EDIT_CALL_PREVIEW_STATE = Symbol("piBaseEditCallPreviewState");

type EditCallPreviewState = {
  signature: string;
  previewLines: string[] | undefined;
};

function summarizeInsertedText(text: string): string[] {
  const lines = splitNewTextLines(String(text));
  const display = lines.slice(0, 5).map((line) => `+ ${escapeControlCharsForDisplay(line)}`);
  if (lines.length > 5) display.push(`+ ... (${lines.length - 5} more lines)`);
  return display;
}

function loadPreviewLines(absolutePath: string, cachedLines?: string[]): string[] | undefined {
  try {
    const raw = readFileSync(absolutePath, "utf8");
    return normalizeToLF(stripBom(raw).text).split("\n");
  } catch {
    return cachedLines;
  }
}

function buildEditCallPreviewSignature(absolutePath: string, args: any): string {
  return JSON.stringify({ path: absolutePath, edits: args?.edits });
}

function rememberEditCallPreviewSnapshot(snapshots: Map<string, string[]>, signature: string, lines: string[]): void {
  if (snapshots.has(signature)) snapshots.delete(signature);
  snapshots.set(signature, [...lines]);
  while (snapshots.size > MAX_EDIT_CALL_PREVIEW_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

function getFrozenPreviewLines(text: Text, signature: string, load: () => string[] | undefined): string[] | undefined {
  const existing = (text as any)[EDIT_CALL_PREVIEW_STATE] as EditCallPreviewState | undefined;
  if (existing?.signature === signature) return existing.previewLines;
  const previewLines = load();
  const state = {
    signature,
    previewLines: previewLines ? [...previewLines] : undefined,
  } satisfies EditCallPreviewState;
  (text as any)[EDIT_CALL_PREVIEW_STATE] = state;
  return state.previewLines;
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
  if (after === "") return `| ${formatHashlineDisplay(1, "", 1)}`;
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
  if (changedIndexes.length === 0) return `| ${formatHashlineDisplay(1, after, width)}`;

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
        output.push(`| ${formatHashlineDisplay(entry.line, visualizeLeadingWhitespace(entry.content), width)}`);
        continue;
      }
      if (entry.kind === "added") {
        output.push(`+ ${formatHashlineDisplay(entry.line, visualizeLeadingWhitespace(entry.content), width)}`);
        continue;
      }
      output.push(`- ${formatHashlineDisplay(entry.line, visualizeLeadingWhitespace(entry.content), width)}`);
    }
  });
  if (merged[merged.length - 1]!.end < entries.length - 1) output.push("...");
  return output.join("\n");
}

function splitPreviewNewLines(text: string): string[] {
  // Preview must use the exact same line-splitting semantics as execution.
  return splitNewTextLines(String(text));
}

function formatPreviewLine(prefix: " " | "+" | "-", lineNumber: number, content: string, width: number, theme: any): string {
  const rendered = `${prefix} ${String(lineNumber).padStart(width, " ")} ${escapeControlCharsForDisplay(visualizeLeadingWhitespace(content))}`;
  if (prefix === "+") return styleDiffAdded(theme, rendered);
  if (prefix === "-") return styleDiffRemoved(theme, rendered);
  return styleDiffContext(theme, rendered);
}

function collectContext(lines: string[], start: number, end: number): { before: Array<{ line: number; content: string }>; after: Array<{ line: number; content: string }> } {
  const before: Array<{ line: number; content: string }> = [];
  const after: Array<{ line: number; content: string }> = [];
  for (let line = Math.max(1, start - CALL_CONTEXT_LINES); line < start; line++) {
    before.push({ line, content: lines[line - 1] ?? "" });
  }
  for (let line = end + 1; line <= Math.min(lines.length, end + CALL_CONTEXT_LINES); line++) {
    after.push({ line, content: lines[line - 1] ?? "" });
  }
  return { before, after };
}

function renderReplacePreview(lines: string[], entry: any, width: number, theme: any): string[] {
  const startRef = safeParseLineRef(entry.replace_lines.start_anchor);
  const endRef = safeParseLineRef(entry.replace_lines.end_anchor);
  if (!startRef || !endRef) return [styleWarning(theme, "? invalid anchor in replace_lines")];
  const start = startRef.line;
  const end = endRef.line;
  const newLines = splitPreviewNewLines(entry.replace_lines.new_text);
  const { before, after } = collectContext(lines, start, end);
  const delta = newLines.length - (end - start + 1);
  return [
    styleToolTitle(theme, "replace_lines"),
    ...before.map((item) => formatPreviewLine(" ", item.line, item.content, width, theme)),
    ...lines.slice(start - 1, end).map((content, index) => formatPreviewLine("-", start + index, content ?? "", width, theme)),
    ...newLines.map((content, index) => formatPreviewLine("+", start + index, content, width, theme)),
    ...after.map((item) => formatPreviewLine(" ", item.line + delta, item.content, width, theme)),
  ];
}

function renderDeletePreview(lines: string[], entry: any, width: number, theme: any): string[] {
  const startRef = safeParseLineRef(entry.delete_lines.start_anchor);
  const endRef = safeParseLineRef(entry.delete_lines.end_anchor);
  if (!startRef || !endRef) return [styleWarning(theme, "? invalid anchor in delete_lines")];
  const start = startRef.line;
  const end = endRef.line;
  const { before, after } = collectContext(lines, start, end);
  const delta = -(end - start + 1);
  return [
    styleToolTitle(theme, "delete_lines"),
    ...before.map((item) => formatPreviewLine(" ", item.line, item.content, width, theme)),
    ...lines.slice(start - 1, end).map((content, index) => formatPreviewLine("-", start + index, content ?? "", width, theme)),
    ...after.map((item) => formatPreviewLine(" ", item.line + delta, item.content, width, theme)),
  ];
}

function renderInsertBeforePreview(lines: string[], entry: any, width: number, theme: any): string[] {
  const anchorRef = safeParseLineRef(entry.insert_before.anchor);
  if (!anchorRef) return [styleWarning(theme, "? invalid anchor in insert_before")];
  const anchor = anchorRef.line;
  const newLines = splitPreviewNewLines(entry.insert_before.new_text);
  const { before, after } = collectContext(lines, anchor, anchor);
  const delta = newLines.length;
  return [
    styleToolTitle(theme, "insert_before"),
    ...before.map((item) => formatPreviewLine(" ", item.line, item.content, width, theme)),
    ...newLines.map((content, index) => formatPreviewLine("+", anchor + index, content, width, theme)),
    formatPreviewLine(" ", anchor + delta, lines[anchor - 1] ?? "", width, theme),
    ...after.map((item) => formatPreviewLine(" ", item.line + delta, item.content, width, theme)),
  ];
}

function renderInsertAfterPreview(lines: string[], entry: any, width: number, theme: any): string[] {
  const anchorRef = safeParseLineRef(entry.insert_after.anchor);
  if (!anchorRef) return [styleWarning(theme, "? invalid anchor in insert_after")];
  const anchor = anchorRef.line;
  const newLines = splitPreviewNewLines(entry.insert_after.new_text);
  const { before, after } = collectContext(lines, anchor, anchor);
  const delta = newLines.length;
  return [
    styleToolTitle(theme, "insert_after"),
    ...before.map((item) => formatPreviewLine(" ", item.line, item.content, width, theme)),
    formatPreviewLine(" ", anchor, lines[anchor - 1] ?? "", width, theme),
    ...newLines.map((content, index) => formatPreviewLine("+", anchor + 1 + index, content, width, theme)),
    ...after.map((item) => formatPreviewLine(" ", item.line + delta, item.content, width, theme)),
  ];
}

function buildPerOperationPreview(args: any, previewLines: string[] | undefined, theme: any): string | undefined {
  if (!previewLines || !Array.isArray(args?.edits) || args.edits.length === 0) return undefined;
  const width = String(previewLines.length + args.edits.length * 8).length;
  const blocks = args.edits.map((entry: any) => {
    if (entry?.replace_lines) return renderReplacePreview(previewLines, entry, width, theme);
    if (entry?.delete_lines) return renderDeletePreview(previewLines, entry, width, theme);
    if (entry?.insert_before) return renderInsertBeforePreview(previewLines, entry, width, theme);
    if (entry?.insert_after) return renderInsertAfterPreview(previewLines, entry, width, theme);
    return [styleWarning(theme, "? unknown_edit")];
  });
  return blocks.map((block: string[]) => block.join("\n")).join("\n\n");
}

function formatEditCall(args: any, theme: any, previewLines?: string[]): string {
  const path = String(args?.path ?? "<missing-path>");
  const edits = Array.isArray(args?.edits) ? args.edits : [];
  const lines = [`${styleToolTitle(theme, "edit")} ${styleAccent(theme, path)}`];
  if (edits.length === 0) return `${lines[0]}\n\n(no edits)`;
  const operationPreview = buildPerOperationPreview(args, previewLines, theme);
  if (operationPreview) {
    const note = edits.length > 1 ? `${styleMuted(theme, "Each hunk below is shown against the pre-edit file.")}\n\n` : "";
    return `${lines[0]}\n\n${note}${operationPreview}`;
  }
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

function buildStaleError(path: string, error: HashlineMismatchError): { content: [{ type: "text"; text: string }]; isError: true } {
  const recent = error.updatedAnchors.slice(0, 12);
  const anchorBlock = recent.length > 0
    ? ["Refreshed anchors near the failed region:", "", ...recent.map((line) => `  ${line.display}`)].join("\n")
    : "Re-read the file to obtain fresh anchors.";
  return {
    content: [{ type: "text", text: `Edit failed for ${path}. The anchor no longer matches the current file.\nUse the refreshed anchors from the latest read/edit result for this region, or rerun read if you need broader context.\n\n${anchorBlock}` }],
    isError: true,
  };
}

export function registerEditTool(
  pi: ExtensionAPI,
  options: {
    wasReadInSession?: (absolutePath: string) => boolean;
    getCachedLines?: (absolutePath: string) => string[] | undefined;
    getCollapsedResultLines?: CollapsedResultLinesResolver;
    onSuccessfulEdit?: (absolutePath: string, lines?: string[]) => void;
  } = {},
) {
  const callPreviewSnapshots = new Map<string, string[]>();
  const tool = {
    name: "edit",
    label: "Edit",
    description: loadToolDescription("edit"),
    promptSnippet: loadToolPromptSnippet("edit"),
    parameters: editSchema,
    renderShell: "default" as const,
    renderCall(args: any, _theme: any, context: any) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const rawPath = String(args?.path ?? "").replace(/^@/, "");
      const absolutePath = rawPath ? resolveToCwd(rawPath, context.cwd ?? process.cwd()) : "";
      const signature = buildEditCallPreviewSignature(absolutePath, args);
      const previewLines = getFrozenPreviewLines(text, signature, () => {
        const remembered = callPreviewSnapshots.get(signature);
        if (remembered) return remembered;
        const loaded = absolutePath ? loadPreviewLines(absolutePath, options.getCachedLines?.(absolutePath)) : undefined;
        if (loaded) rememberEditCallPreviewSnapshot(callPreviewSnapshots, signature, loaded);
        return loaded;
      });
      text.setText(formatEditCall(args, _theme, previewLines));
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
        const previewSignature = buildEditCallPreviewSignature(absolutePath, params);
        if (options.wasReadInSession && !options.wasReadInSession(absolutePath)) {
          return {
            content: [{ type: "text" as const, text: `Edit failed for ${rawPath}. Fresh anchors are required before editing this file. Start with read, grep, write, or a prior edit result for the same region.` }],
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
          rememberEditCallPreviewSnapshot(callPreviewSnapshots, previewSignature, original.split("\n"));
          let next;
          try {
            next = applyHashlineEdits(original, params.edits as HashlineEditItem[], signal);
          } catch (error) {
            if (error instanceof HashlineMismatchError) return buildStaleError(rawPath, error);
            return { content: [{ type: "text" as const, text: `Edit failed for ${rawPath}. ${(error as Error).message}` }], isError: true };
          }

          if (next.content === original) {
            return { content: [{ type: "text" as const, text: `Edit failed for ${rawPath}. The requested edits would not change the file.` }], isError: true };
          }

          const writeContent = bom + restoreLineEndings(next.content, originalEnding);
          throwIfAborted(signal);
          await throwIfAbortedAfter(writeFile(absolutePath, writeContent, "utf8"), signal);
          const nextLines = next.content.split("\n");
          options.onSuccessfulEdit?.(absolutePath, nextLines);

          const diffText = buildResultDiff(original, next.content);
          const diff = generateCompactOrFullDiff(original, next.content).diff;

          return {
            content: [{ type: "text" as const, text: `Edit applied to ${rawPath}.\nReview the diff below. Lines prefixed with "+" or "|" carry the current LINE:HASH anchors for follow-up edits in this region.\n\n${diffText}` }],
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
