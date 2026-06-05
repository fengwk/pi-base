import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const DEFAULT_COLLAPSED_RESULT_LINES = 20;
const HASHLINE_RE = /^(\s*\d+#[0-9a-fA-F]{4}\|)(.*)$/;
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

export function resolveCollapsedResultLines(
  toolName: string,
  defaultCollapsedLines: number | undefined,
  context: { cwd?: string } | undefined,
  getCollapsedResultLines?: CollapsedResultLinesResolver,
): number | undefined {
  const configured = getCollapsedResultLines?.(context?.cwd ?? process.cwd(), toolName);
  return configured ?? defaultCollapsedLines;
}

export function renderCallText(textValue: string, lastComponent?: unknown) {
  const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(textValue);
  return text;
}

function colorizeResultValue(key: string, value: string, theme: any): string {
  if (!value) return "";
  if (key === "path" || key === "nextOffset") return paint(theme, "accent", value);
  if (key === "status") return paint(theme, value === "ok" ? "success" : "error", value);
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
  if (line.startsWith("Edit applied to ")) return paint(theme, "success", line);
  if (line.startsWith("Created ") || line.startsWith("Overwrote ")) return paint(theme, "success", line);
  if (line.startsWith("Verify that the result matches the intended change.")) return paint(theme, "warning", line);
  if (line.startsWith("Review the written file content below.")) return paint(theme, "warning", line);
  if (line.startsWith("Edit failed")) return paint(theme, "error", line);
  if (line.startsWith("Use the refreshed anchors ")) return paint(theme, "warning", line);
  if (line.startsWith("Use these LINE#HASH anchors ")) return paint(theme, "warning", line);
  if (isError && line.startsWith("Validation failed")) return paint(theme, "error", line);

  const hashlineMatch = line.match(HASHLINE_RE);
  if (hashlineMatch) {
    return `${paint(theme, "muted", hashlineMatch[1] ?? "")}${paint(theme, "toolOutput", hashlineMatch[2] ?? "")}`;
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

export function renderRawResult(result: any, options: { expanded?: boolean; collapsedLines?: number; isPartial?: boolean } | undefined, theme: any, context: { lastComponent?: unknown; isError?: boolean }) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const parts = Array.isArray(result?.content)
    ? result.content.map((item: any) => {
        if (item?.type === "text") return String(item.text ?? "");
        if (item?.type === "image") return "[image attachment]";
        return `[${String(item?.type ?? "unknown")} attachment]`;
      })
    : [""];
  const body = colorizeResultBody(parts.join("\n\n"), theme, Boolean(context.isError));
  const bodyLines = body ? body.split("\n") : [];
  const collapsedLines = typeof options?.collapsedLines === "number" && Number.isFinite(options.collapsedLines) && options.collapsedLines >= 0
    ? Math.floor(options.collapsedLines)
    : DEFAULT_COLLAPSED_RESULT_LINES;
  if (options?.expanded || bodyLines.length <= collapsedLines) {
    text.setText(bodyLines.length ? bodyLines.join("\n") : "");
    return text;
  }
  const visible = bodyLines.slice(0, collapsedLines);
  const remaining = bodyLines.length - collapsedLines;
  const tail = paint(theme, "dim", `... (${remaining} more lines, ctrl+o to expand)`);
  text.setText([...visible, tail].join("\n"));
  return text;
}
