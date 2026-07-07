import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const INTERNAL_DEFAULT_COLLAPSED_RESULT_LINES = {
  "*": 20,
  bash: 20,
  grep: 15,
  read: 10,
  write: 10,
} as const;
const MISSING_CALL_ARG_RE = /<missing-[^>]+>/g;
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
  return configured ?? defaultCollapsedLines ?? resolveToolPatternValue(INTERNAL_DEFAULT_COLLAPSED_RESULT_LINES, toolName);
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


const STREAMING_CALL_PREVIEW_LINES = 10;

interface StreamingCallWindowState {
  text: string;
  theme: any;
  cachedWidth: number | undefined;
  cachedLines: string[] | undefined;
  cachedSkipped: number | undefined;
}

/**
 * Rolling-window component for streaming tool calls.
 *
 * While the model is still emitting arguments (argsComplete === false), the call
 * preview can grow very long (e.g. write content, edit diff preview). Instead of
 * letting the call block expand unbounded, this component keeps the first line
 * (tool title + streaming label) pinned and shows only the last few lines of the
 * body, with a truncation hint in between. Once argsComplete becomes true the
 * caller switches back to a plain Text for full rendering.
 */
class StreamingCallWindowComponent {
  private state: StreamingCallWindowState;

  constructor(text: string, theme: any) {
    this.state = { text, theme, cachedWidth: undefined, cachedLines: undefined, cachedSkipped: undefined };
  }

  update(text: string, theme: any): void {
    if (text !== this.state.text) {
      this.state.text = text;
      this.state.cachedWidth = undefined;
    }
    this.state.theme = theme;
  }

  render(width: number): string[] {
    const s = this.state;
    if (s.cachedLines === undefined || s.cachedWidth !== width) {
      const allLines = new Text(s.text, 0, 0).render(width);
      if (allLines.length <= STREAMING_CALL_PREVIEW_LINES) {
        s.cachedLines = allLines;
        s.cachedSkipped = 0;
      } else {
        // Pin the first line (tool title + streaming label) so the user always
        // knows which tool and target are active, then show the trailing lines.
        const headerLine = allLines[0] ?? "";
        const tailCount = STREAMING_CALL_PREVIEW_LINES - 1;
        const tail = allLines.slice(-tailCount);
        s.cachedLines = [headerLine, ...tail];
        s.cachedSkipped = allLines.length - 1 - tailCount;
      }
      s.cachedWidth = width;
    }
    if (s.cachedSkipped && s.cachedSkipped > 0) {
      // Keep the pinned title + trailing body together, and place the
      // truncation hint at the very bottom so the block reads top-to-bottom
      // without a divider wedged between the title and the content.
      const hint = styleMuted(s.theme, `... (${s.cachedSkipped} earlier lines)`);
      return [...(s.cachedLines ?? []), hint];
    }
    return s.cachedLines ?? [];
  }

  invalidate(): void {
    this.state.cachedWidth = undefined;
    this.state.cachedLines = undefined;
    this.state.cachedSkipped = undefined;
  }
}

export function renderCallText(textValue: string, lastComponent?: unknown) {
  const text = (lastComponent instanceof Text) ? lastComponent : new Text("", 0, 0);
  text.setText(textValue);
  return text;
}

export interface CallRenderContextLike {
  lastComponent?: unknown;
  argsComplete?: boolean;
  executionStarted?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
}

function isStreamingCall(context: CallRenderContextLike | undefined): boolean {
  // Collapse into the rolling window only while the model is still emitting
  // arguments AND the tool has neither started running nor produced a result.
  // Once execution starts, or a result has settled (isPartial === false, e.g.
  // when a stored session is re-rendered from history), the arguments are
  // necessarily final, so the full call must be rendered even if the host
  // never flipped argsComplete to true.
  if (context?.argsComplete !== false) return false;
  if (context?.executionStarted) return false;
  if (context?.isPartial === false) return false;
  return true;
}

function normalizeStreamingCallPlaceholders(textValue: string): string {
  return textValue.replace(MISSING_CALL_ARG_RE, "...");
}

function injectStreamingCallLabel(textValue: string, theme: any): string {
  const label = styleMuted(theme, " [streaming args]");
  const firstNewline = textValue.indexOf("\n");
  if (firstNewline === -1) return `${textValue}${label}`;
  return `${textValue.slice(0, firstNewline)}${label}${textValue.slice(firstNewline)}`;
}

export function renderStreamingCallText(textValue: string, theme: any, context: CallRenderContextLike | undefined) {
  if (!isStreamingCall(context)) return renderCallText(textValue, context?.lastComponent);
  const normalized = injectStreamingCallLabel(normalizeStreamingCallPlaceholders(textValue), theme);
  const last = context?.lastComponent;
  if (last instanceof StreamingCallWindowComponent) {
    last.update(normalized, theme);
    return last;
  }
  return new StreamingCallWindowComponent(normalized, theme);
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

  const numberedLineMatch = line.match(/^(\s*\d+\|)(.*)$/);
  if (numberedLineMatch) {
    return `${paint(theme, "muted", numberedLineMatch[1] ?? "")}${paint(theme, "toolOutput", numberedLineMatch[2] ?? "")}`;
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
  const collapsedLines = typeof options?.collapsedLines === "number" && Number.isFinite(options.collapsedLines) && options.collapsedLines >= 0
    ? Math.floor(options.collapsedLines)
    : INTERNAL_DEFAULT_COLLAPSED_RESULT_LINES["*"];
  const maxCollapsedChars = typeof options?.maxCollapsedChars === "number" && Number.isFinite(options.maxCollapsedChars) && options.maxCollapsedChars >= 0
    ? Math.floor(options.maxCollapsedChars)
    : undefined;
  if (options?.expanded) {
    text.setText(withLeadingResultNewline(rawBody ? colorizeResultBody(rawBody, theme, Boolean(context.isError)) : ""));
    return text;
  }

  // collapsedLines <= 0 hides the collapsed preview entirely (used by read/grep/find/
  // edit/write); an empty body has nothing to show either.
  if (collapsedLines <= 0 || !rawBody) {
    text.setText("");
    return text;
  }

  // Step 1: apply the character budget first so long single-line output stays visible
  // instead of being dropped by the line-count gate below.
  const charTruncated = typeof maxCollapsedChars === "number" && rawBody.length > maxCollapsedChars;
  const charLimitedBody = charTruncated ? rawBody.slice(0, maxCollapsedChars) : rawBody;

  // Step 2: only fold when the content exceeds the configured line count; when it fits,
  // show it as-is. When folding, the last line of the window is reserved for the hint.
  const limitedLines = charLimitedBody ? charLimitedBody.split("\n") : [];
  const lineTruncated = limitedLines.length > collapsedLines;
  const visibleLineCount = Math.max(0, lineTruncated ? collapsedLines - 1 : limitedLines.length);
  const remaining = Math.max(0, limitedLines.length - visibleLineCount);
  const visibleBody = limitedLines.slice(0, visibleLineCount).join("\n");

  const tailDetails = [
    remaining > 0 ? `${remaining} more lines` : undefined,
    charTruncated ? "output truncated" : undefined,
    remaining > 0 || charTruncated ? "ctrl+o to expand" : undefined,
  ].filter((part): part is string => Boolean(part));
  const body = visibleBody ? colorizeResultBody(visibleBody, theme, Boolean(context.isError)) : "";
  if (tailDetails.length === 0) {
    text.setText(withLeadingResultNewline(body));
    return text;
  }
  const tail = paint(theme, "dim", `... (${tailDetails.join(", ")})`);
  text.setText(withLeadingResultNewline(body ? `${body}\n${tail}` : tail));
  return text;
}
