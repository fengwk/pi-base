import { readFileSync } from "node:fs";
import { Text } from "@earendil-works/pi-tui";
import { normalizeToLF, stripBom } from "./edit-diff.js";
import { escapeControlCharsForDisplay, splitNewTextLines } from "./hashline.js";
import { describeToolWorkdirForDisplay, resolveToCwd, resolveToolWorkdir, stripAtPrefix } from "./path-utils.js";
import { styleAccent, styleDiffAdded, styleDiffContext, styleDiffRemoved, styleMuted, styleToolTitle, styleWarning } from "./render.js";
import { formatAnchorRefForDisplay, getLineRefError, safeParseLineRef, visualizeLeadingWhitespace } from "./edit-display.js";

const MAX_EDIT_CALL_PREVIEW_SNAPSHOTS = 100;
const EDIT_CALL_PREVIEW_STATE = Symbol("piBaseEditCallPreviewState");
const PREVIEW_CONTEXT_LINES = 3;

export type EditCallPreviewSnapshots = Map<string, string[]>;

export interface RenderEditCallPreviewOptions {
  getCachedLines?: (absolutePath: string) => string[] | undefined;
}

type EditCallPreviewState = {
  signature: string;
  previewLines: string[] | undefined;
};

function renderInsertedText(text: string): string[] {
  return splitNewTextLines(String(text)).map((line) => `+ ${escapeControlCharsForDisplay(visualizeLeadingWhitespace(line))}`);
}

function loadPreviewLines(absolutePath: string, cachedLines?: string[]): string[] | undefined {
  try {
    const raw = readFileSync(absolutePath, "utf8");
    return normalizeToLF(stripBom(raw).text).split("\n");
  } catch {
    return cachedLines;
  }
}

export function buildEditCallPreviewSignature(absolutePath: string, args: any): string {
  return JSON.stringify({ path: absolutePath, edits: args?.edits });
}

export function rememberEditCallPreviewSnapshot(snapshots: EditCallPreviewSnapshots, signature: string, lines: string[]): void {
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

function splitPreviewNewLines(text: unknown): string[] {
  return splitNewTextLines(String(text ?? ""));
}

function formatAnchorRange(startAnchor: string | undefined, endAnchor: string | undefined): string {
  return `${formatAnchorRefForDisplay(startAnchor)} .. ${formatAnchorRefForDisplay(endAnchor)}`;
}

function formatInvalidAnchorWarning(operation: string, anchors: Array<string | undefined>, theme: any): string | undefined {
  const error = anchors.map((anchor) => getLineRefError(anchor)).find((message) => message !== undefined);
  return error ? styleWarning(theme, `? invalid anchor in ${operation}: ${error}`) : undefined;
}

function formatPreviewLine(prefix: " " | "+" | "-", lineNumber: number, content: string, width: number, theme: any): string {
  const rendered = `${prefix} ${String(lineNumber).padStart(width, " ")} ${escapeControlCharsForDisplay(visualizeLeadingWhitespace(content))}`;
  if (prefix === "+") return styleDiffAdded(theme, rendered);
  if (prefix === "-") return styleDiffRemoved(theme, rendered);
  return styleDiffContext(theme, rendered);
}

function collectBeforeLines(lines: string[], endLine: number): Array<{ line: number; content: string }> {
  const start = Math.max(1, endLine - PREVIEW_CONTEXT_LINES + 1);
  const end = Math.min(lines.length, endLine);
  const result: Array<{ line: number; content: string }> = [];
  for (let line = start; line <= end; line++) result.push({ line, content: lines[line - 1] ?? "" });
  return result;
}

function collectAfterLines(lines: string[], startLine: number): Array<{ line: number; content: string }> {
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, start + PREVIEW_CONTEXT_LINES - 1);
  const result: Array<{ line: number; content: string }> = [];
  for (let line = start; line <= end; line++) result.push({ line, content: lines[line - 1] ?? "" });
  return result;
}

function renderReplacePreview(lines: string[], entry: any, width: number, theme: any): string[] {
  const anchorError = formatInvalidAnchorWarning("replace_lines", [entry.replace_lines.start_anchor, entry.replace_lines.end_anchor], theme);
  if (anchorError) return [anchorError];
  const startRef = safeParseLineRef(entry.replace_lines.start_anchor);
  const endRef = safeParseLineRef(entry.replace_lines.end_anchor);
  const start = startRef!.line;
  const end = endRef!.line;
  const anchorRange = formatAnchorRange(entry.replace_lines.start_anchor, entry.replace_lines.end_anchor);
  const newLines = splitPreviewNewLines(entry.replace_lines.new_text);
  const delta = newLines.length - (end - start + 1);
  return [
    styleToolTitle(theme, `replace_lines ${anchorRange}`),
    ...collectBeforeLines(lines, start - 1).map((item) => formatPreviewLine(" ", item.line, item.content, width, theme)),
    ...lines.slice(start - 1, end).map((content, index) => formatPreviewLine("-", start + index, content ?? "", width, theme)),
    ...newLines.map((content, index) => formatPreviewLine("+", start + index, content, width, theme)),
    ...collectAfterLines(lines, end + 1).map((item) => formatPreviewLine(" ", item.line + delta, item.content, width, theme)),
  ];
}

function renderDeletePreview(lines: string[], entry: any, width: number, theme: any): string[] {
  const anchorError = formatInvalidAnchorWarning("delete_lines", [entry.delete_lines.start_anchor, entry.delete_lines.end_anchor], theme);
  if (anchorError) return [anchorError];
  const startRef = safeParseLineRef(entry.delete_lines.start_anchor);
  const endRef = safeParseLineRef(entry.delete_lines.end_anchor);
  const start = startRef!.line;
  const end = endRef!.line;
  const anchorRange = formatAnchorRange(entry.delete_lines.start_anchor, entry.delete_lines.end_anchor);
  const delta = -(end - start + 1);
  return [
    styleToolTitle(theme, `delete_lines ${anchorRange}`),
    ...collectBeforeLines(lines, start - 1).map((item) => formatPreviewLine(" ", item.line, item.content, width, theme)),
    ...lines.slice(start - 1, end).map((content, index) => formatPreviewLine("-", start + index, content ?? "", width, theme)),
    ...collectAfterLines(lines, end + 1).map((item) => formatPreviewLine(" ", item.line + delta, item.content, width, theme)),
  ];
}

function renderInsertBeforeLinesPreview(lines: string[], entry: any, width: number, theme: any): string[] {
  const anchorError = formatInvalidAnchorWarning("insert_before_lines", [entry.insert_before_lines.anchor], theme);
  if (anchorError) return [anchorError];
  const anchorRef = safeParseLineRef(entry.insert_before_lines.anchor);
  const anchor = anchorRef!.line;
  const anchorLabel = formatAnchorRefForDisplay(entry.insert_before_lines.anchor);
  const newLines = splitPreviewNewLines(entry.insert_before_lines.new_text);
  const delta = newLines.length;
  return [
    styleToolTitle(theme, `insert_before_lines ${anchorLabel}`),
    ...newLines.map((content, index) => formatPreviewLine("+", anchor + index, content, width, theme)),
    ...collectAfterLines(lines, anchor).map((item) => formatPreviewLine(" ", item.line + delta, item.content, width, theme)),
  ];
}

function renderInsertAfterLinesPreview(lines: string[], entry: any, width: number, theme: any): string[] {
  const anchorError = formatInvalidAnchorWarning("insert_after_lines", [entry.insert_after_lines.anchor], theme);
  if (anchorError) return [anchorError];
  const anchorRef = safeParseLineRef(entry.insert_after_lines.anchor);
  const anchor = anchorRef!.line;
  const anchorLabel = formatAnchorRefForDisplay(entry.insert_after_lines.anchor);
  const newLines = splitPreviewNewLines(entry.insert_after_lines.new_text);
  return [
    styleToolTitle(theme, `insert_after_lines ${anchorLabel}`),
    ...collectBeforeLines(lines, anchor).map((item) => formatPreviewLine(" ", item.line, item.content, width, theme)),
    ...newLines.map((content, index) => formatPreviewLine("+", anchor + 1 + index, content, width, theme)),
  ];
}

function buildPerOperationPreview(args: any, previewLines: string[] | undefined, theme: any): string | undefined {
  if (!previewLines || !Array.isArray(args?.edits) || args.edits.length === 0) return undefined;
  const width = String(previewLines.length + args.edits.length * 8).length;
  const blocks = args.edits.map((entry: any) => {
    if (entry?.replace_lines) return renderReplacePreview(previewLines, entry, width, theme);
    if (entry?.delete_lines) return renderDeletePreview(previewLines, entry, width, theme);
    if (entry?.insert_before_lines) return renderInsertBeforeLinesPreview(previewLines, entry, width, theme);
    if (entry?.insert_after_lines) return renderInsertAfterLinesPreview(previewLines, entry, width, theme);
    return [styleWarning(theme, "? unknown_edit")];
  });
  return blocks.map((block: string[]) => block.join("\n")).join("\n\n");
}

function formatEditCall(args: any, theme: any, cwd?: string, previewLines?: string[]): string {
  const path = String(args?.path ?? "<missing-path>");
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleMuted(theme, " in ")}${styleAccent(theme, rawWorkdir)}`;
  const edits = Array.isArray(args?.edits) ? args.edits : [];
  const lines = [`${styleToolTitle(theme, "edit")} ${styleAccent(theme, path)}${workdir}`];
  if (edits.length === 0) return `${lines[0]}\n\n(no edits)`;
  const operationPreview = buildPerOperationPreview(args, previewLines, theme);
  if (operationPreview) {
    const note = edits.length > 1 ? `${styleMuted(theme, "Each hunk below is shown against the pre-edit file.")}\n\n` : "";
    return `${lines[0]}\n\n${note}${operationPreview}`;
  }
  for (const entry of edits) {
    lines.push("");
    if (entry?.replace_lines) {
      const anchorRange = formatAnchorRange(entry.replace_lines.start_anchor, entry.replace_lines.end_anchor);
      lines.push(styleToolTitle(theme, `replace_lines ${anchorRange}`));
      lines.push(styleDiffRemoved(theme, `- range ${anchorRange}`));
      lines.push(...renderInsertedText(String(entry.replace_lines.new_text ?? "")).map((line) => styleDiffAdded(theme, line)));
      continue;
    }
    if (entry?.delete_lines) {
      const anchorRange = formatAnchorRange(entry.delete_lines.start_anchor, entry.delete_lines.end_anchor);
      lines.push(styleToolTitle(theme, `delete_lines ${anchorRange}`));
      lines.push(styleDiffRemoved(theme, `- range ${anchorRange}`));
      continue;
    }
    if (entry?.insert_before_lines) {
      const anchorLabel = formatAnchorRefForDisplay(entry.insert_before_lines.anchor);
      lines.push(styleToolTitle(theme, `insert_before_lines ${anchorLabel}`));
      lines.push(styleDiffContext(theme, `| before ${anchorLabel}`));
      lines.push(...renderInsertedText(String(entry.insert_before_lines.new_text ?? "")).map((line) => styleDiffAdded(theme, line)));
      continue;
    }
    if (entry?.insert_after_lines) {
      const anchorLabel = formatAnchorRefForDisplay(entry.insert_after_lines.anchor);
      lines.push(styleToolTitle(theme, `insert_after_lines ${anchorLabel}`));
      lines.push(styleDiffContext(theme, `| after ${anchorLabel}`));
      lines.push(...renderInsertedText(String(entry.insert_after_lines.new_text ?? "")).map((line) => styleDiffAdded(theme, line)));
      continue;
    }
    lines.push(styleWarning(theme, "? unknown_edit"));
  }
  return lines.join("\n");
}

export function renderEditCall(
  args: any,
  theme: any,
  context: any,
  snapshots: EditCallPreviewSnapshots,
  options: RenderEditCallPreviewOptions = {},
): Text {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const rawPath = stripAtPrefix(String(args?.path ?? ""));
  const state = context.state ?? ((context.state = {}));
  const hasCurrentEdits = Array.isArray(args?.edits) && args.edits.length > 0;
  if (hasCurrentEdits) state.lastEditPreviewArgs = args;
  const renderArgs = hasCurrentEdits || context.argsComplete ? args : (state.lastEditPreviewArgs ?? args);
  const hasRenderableEdits = Array.isArray(renderArgs?.edits) && renderArgs.edits.length > 0;
  if (!hasRenderableEdits && !context.argsComplete) {
    text.setText(`${styleToolTitle(theme, "edit")} ${styleAccent(theme, rawPath || "<missing-path>")}`);
    return text;
  }
  const { cwd: previewCwd } = resolveToolWorkdir(renderArgs?.workdir, context.cwd ?? process.cwd());
  const absolutePath = rawPath ? resolveToCwd(rawPath, previewCwd) : "";
  const signature = buildEditCallPreviewSignature(absolutePath, renderArgs);
  const previewLines = getFrozenPreviewLines(text, signature, () => {
    const remembered = snapshots.get(signature);
    if (remembered) return remembered;
    const loaded = absolutePath ? loadPreviewLines(absolutePath, options.getCachedLines?.(absolutePath)) : undefined;
    if (loaded) rememberEditCallPreviewSnapshot(snapshots, signature, loaded);
    return loaded;
  });
  text.setText(formatEditCall(renderArgs, theme, context?.cwd, previewLines));
  return text;
}
