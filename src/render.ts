import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const DEFAULT_COLLAPSED_RESULT_LINES = 20;
const KEY_VALUE_RE = /^([A-Za-z][A-Za-z0-9]*):(?!\/\/)(?:\s*(.*))?$/;
const SECTION_HEADER_RE = /^([A-Za-z][A-Za-z0-9 ]*):$/;

function paint(theme: any, color: string, text: string): string {
  return theme?.fg ? theme.fg(color, text) : text;
}

function emphasize(theme: any, text: string): string {
  if (!theme?.fg) return text;
  return theme.fg("toolTitle", theme.bold ? theme.bold(text) : text);
}

export function shortenHomePath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

export function formatInlineValue(value: unknown): string {
  if (typeof value === "string") {
    if (value === "") return '""';
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }
  return String(value);
}

export function formatOptionalArgs(entries: Array<[string, unknown]>): string {
  const present = entries.filter(([, value]) => value !== undefined);
  if (present.length === 0) return "";
  return ` [${present.map(([key, value]) => `${key}=${formatInlineValue(value)}`).join(", ")}]`;
}

export function styleToolTitle(theme: any, text: string): string {
  return emphasize(theme, text);
}

export function styleAccent(theme: any, text: string): string {
  return paint(theme, "accent", text);
}

export function styleMuted(theme: any, text: string): string {
  return paint(theme, "muted", text);
}

export function styleOutput(theme: any, text: string): string {
  return paint(theme, "toolOutput", text);
}

export function styleDiffAdded(theme: any, text: string): string {
  return paint(theme, "toolDiffAdded", text);
}

export function styleDiffRemoved(theme: any, text: string): string {
  return paint(theme, "toolDiffRemoved", text);
}

export function styleDiffContext(theme: any, text: string): string {
  return paint(theme, "toolDiffContext", text);
}

export function styleWarning(theme: any, text: string): string {
  return paint(theme, "warning", text);
}

export type CollapsedResultLinesResolver = (cwd: string, toolName: string) => number | undefined;
export type CollapsedResultMaxCharsResolver = (cwd: string, toolName: string) => number | undefined;
export function resolveToolPatternValue(
  config: number | Record<string, number> | undefined,
  toolName: string,
): number | undefined {
  if (config === undefined) return undefined;
  if (typeof config === "number") return config;
  if (Object.prototype.hasOwnProperty.call(config, toolName)) {
    return config[toolName];
  }

  let bestPatternValue: number | undefined;
  let bestSpecificity: [number, number, number] | undefined;
  for (const [pattern, value] of Object.entries(config)) {
    if (pattern === "*" || !pattern.includes("*")) continue;
    if (!matchesToolPattern(pattern, toolName)) continue;

    const specificity = getToolPatternSpecificity(pattern);
    if (!bestSpecificity || compareToolPatternSpecificity(specificity, bestSpecificity) > 0) {
      bestSpecificity = specificity;
      bestPatternValue = value;
    }
  }

  return bestPatternValue ?? config["*"];
}


export function resolveCollapsedResultLines(
  toolName: string,
  defaultCollapsedLines: number | undefined,
  context: { cwd?: string } | undefined,
  getCollapsedResultLines?: CollapsedResultLinesResolver,
): number | undefined {
  const configured = getCollapsedResultLines?.(context?.cwd ?? process.cwd(), toolName);
  return configured ?? defaultCollapsedLines;
}
export function resolveCollapsedResultMaxChars(
  toolName: string,
  defaultMaxChars: number | undefined,
  context: { cwd?: string } | undefined,
  getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver,
): number | undefined {
  const configured = getCollapsedResultMaxChars?.(context?.cwd ?? process.cwd(), toolName);
  return configured ?? defaultMaxChars;
}
function matchesToolPattern(pattern: string, toolName: string): boolean {
  const regex = new RegExp(`^${escapeToolPatternRegex(pattern)}$`);
  return regex.test(toolName);
}

function escapeToolPatternRegex(pattern: string): string {
  return pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
}

function getToolPatternSpecificity(pattern: string): [number, number, number] {
  const wildcardCount = (pattern.match(/\*/g) ?? []).length;
  const literalLength = pattern.length - wildcardCount;
  return [literalLength, -wildcardCount, pattern.length];
}

function compareToolPatternSpecificity(
  left: [number, number, number],
  right: [number, number, number],
): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] !== right[1]) return left[1] - right[1];
  return left[2] - right[2];
}


export function renderCallText(textValue: string, lastComponent?: unknown) {
  const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(textValue);
  return text;
}

export function withLeadingResultNewline(textValue: string): string {
  if (!textValue) return "";
  return textValue.startsWith("\n") ? textValue : `\n${textValue}`;
}

function colorizeResultValue(key: string, value: string, theme: any): string {
  if (!value) return "";
  if (key === "path" || key === "nextOffset") return paint(theme, "accent", value);
  if (key === "status") {
    const normalized = value.trim().toLowerCase();
    if (["ok", "success", "completed"].includes(normalized)) return paint(theme, "success", value);
    if (["running", "pending", "in_progress"].includes(normalized)) return paint(theme, "warning", value);
    return paint(theme, "error", value);
  }
  if (key === "error") return paint(theme, "error", value);
  if (key === "lsp") return paint(theme, value.startsWith("supported") ? "success" : "warning", value);
  if (key === "message") return paint(theme, "toolOutput", value);
  return paint(theme, "toolOutput", value);
}

function colorizeDiffLine(line: string, theme: any): string {
  if (!line) return "";
  if (line.startsWith("+")) return paint(theme, "toolDiffAdded", line);
  if (line.startsWith("-")) return paint(theme, "toolDiffRemoved", line);
  return paint(theme, "toolDiffContext", line);
}

function colorizeResultLine(line: string, theme: any, state: { inDiff: boolean }, isError: boolean): string {
  if (!line) return "";

  if (state.inDiff) return colorizeDiffLine(line, theme);
  if (line === "diff:") {
    state.inDiff = true;
    return emphasize(theme, line);
  }

  if (line.startsWith("Error:")) return paint(theme, "error", line);
  if (line.startsWith("Hint:")) return paint(theme, "warning", line);
  if (line.startsWith("Edited ") || line.startsWith("Created ") || line.startsWith("Overwrote ")) return paint(theme, "success", line);
  if (line.startsWith("Replacements:")) return paint(theme, "muted", line);
  if (isError && line.startsWith("Validation failed")) return paint(theme, "error", line);

  const numberedLineMatch = line.match(/^(\d+):(.*)$/);
  if (numberedLineMatch) {
    return `${paint(theme, "muted", `${numberedLineMatch[1]}:`)}${paint(theme, "toolOutput", numberedLineMatch[2] ?? "")}`;
  }

  if (SECTION_HEADER_RE.test(line) && !KEY_VALUE_RE.test(line.slice(0, -1))) {
    return emphasize(theme, line);
  }

  const keyValueMatch = line.match(KEY_VALUE_RE);
  if (keyValueMatch) {
    const key = keyValueMatch[1] ?? "";
    const value = keyValueMatch[2] ?? "";
    const keyText = paint(theme, "muted", `${key}:`);
    return value ? `${keyText} ${colorizeResultValue(key, value, theme)}` : keyText;
  }

  return paint(theme, "toolOutput", line);
}

function colorizeResultBody(text: string, theme: any, isError: boolean): string {
  const state = { inDiff: false };
  return text
    .split("\n")
    .map((line) => colorizeResultLine(line, theme, state, isError))
    .join("\n");
}

export function renderRawResult(result: any, options: { expanded?: boolean; collapsedLines?: number; maxCollapsedChars?: number; isPartial?: boolean } | undefined, theme: any, context: { lastComponent?: unknown; isError?: boolean }) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const parts = Array.isArray(result?.content)
    ? result.content.map((item: any) => {
        if (item?.type === "text") return String(item.text ?? "");
        if (item?.type === "image") return "[image attachment]";
        return `[${String(item?.type ?? "unknown")} attachment]`;
      })
    : [""];
  const rawBody = parts.join("\n\n");
  const bodyLines = rawBody ? rawBody.split("\n") : [];
  const collapsedLines = typeof options?.collapsedLines === "number" && Number.isFinite(options.collapsedLines) && options.collapsedLines >= 0
    ? Math.floor(options.collapsedLines)
    : DEFAULT_COLLAPSED_RESULT_LINES;
  const maxCollapsedChars = typeof options?.maxCollapsedChars === "number" && Number.isFinite(options.maxCollapsedChars) && options.maxCollapsedChars >= 0
    ? Math.floor(options.maxCollapsedChars)
    : undefined;
  if (options?.expanded || isWithinCollapsedLimits(rawBody, bodyLines.length, collapsedLines, maxCollapsedChars)) {
    text.setText(withLeadingResultNewline(rawBody ? colorizeResultBody(rawBody, theme, Boolean(context.isError)) : ""));
    return text;
  }

  const visibleBody = bodyLines.slice(0, collapsedLines).join("\n");
  const truncatedBody = typeof maxCollapsedChars === "number" && visibleBody.length > maxCollapsedChars
    ? `${visibleBody.slice(0, maxCollapsedChars)}...`
    : visibleBody;
  const remaining = Math.max(0, bodyLines.length - collapsedLines);
  const wasCharTruncated = truncatedBody !== visibleBody;
  const tailDetails = [
    remaining > 0 ? `${remaining} more lines` : undefined,
    wasCharTruncated ? "output truncated" : undefined,
    "ctrl+o to expand",
  ].filter((part): part is string => Boolean(part));
  const tail = paint(theme, "dim", `... (${tailDetails.join(", ")})`);
  const body = truncatedBody ? colorizeResultBody(truncatedBody, theme, Boolean(context.isError)) : "";
  text.setText(withLeadingResultNewline(body ? `${body}\n${tail}` : tail));
  return text;
}

function isWithinCollapsedLimits(body: string, lineCount: number, collapsedLines: number, maxCollapsedChars: number | undefined): boolean {
  if (lineCount > collapsedLines) return false;
  if (typeof maxCollapsedChars === "number" && body.length > maxCollapsedChars) return false;
  return true;
}
