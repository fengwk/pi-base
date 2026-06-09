import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { subagentActivityStore } from "./activity.js";
import { buildTranscriptLines } from "./transcript.js";
import type { SubagentSessionRecord } from "./types.js";

const VIEWER_MAX_TOOL_RESULT_CHARS = 1200;

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function colorizeLine(line: string, theme: any): string {
  if (line === "───") return theme.fg("dim", line);
  if (line === "[User]") return theme.fg("accent", line);
  if (line === "[Assistant]" || line === "[Assistant…]") return theme.fg("toolTitle", theme.bold ? theme.bold(line) : line);
  if (line === "[Result]") return theme.fg("muted", line);
  if (line.startsWith("[Tool] ") || line.startsWith("[Bash] ")) return theme.fg("muted", line);
  if (line.startsWith("[Running] ")) return theme.fg("warning", line);
  return line;
}

export class SubagentConversationViewer implements Component {
  private scrollOffset = 0;
  private autoFollow = true;
  private lastContentWidth = 0;
  private readonly snapshotManager: SessionManager;
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: any,
    private readonly sessionDir: string,
    private readonly record: SubagentSessionRecord,
    private readonly done: (result: undefined) => void,
  ) {
    this.snapshotManager = SessionManager.open(record.info.path, sessionDir);
    const live = subagentActivityStore.get(record.info.id);
    this.unsubscribe = live?.session
      ? live.session.subscribe(() => this.tui.requestRender())
      : undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done(undefined);
      return;
    }

    if (matchesKey(data, "f")) {
      this.autoFollow = !this.autoFollow;
      this.tui.requestRender();
      return;
    }

    const totalLines = this.buildContentLines(this.lastContentWidth).length;
    const viewport = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewport);

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoFollow = false;
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoFollow = this.scrollOffset >= maxScroll;
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewport);
      this.autoFollow = false;
      return;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewport);
      this.autoFollow = this.scrollOffset >= maxScroll;
      return;
    }
    if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoFollow = false;
      return;
    }
    if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoFollow = true;
    }
  }

  render(width: number): string[] {
    if (width < 20) return [];
    const innerWidth = width - 4;
    this.lastContentWidth = Math.max(1, innerWidth);
    const lines: string[] = [];
    const row = (content: string) => `${this.theme.fg("border", "│")} ${truncateToWidth(padVisible(content, innerWidth), innerWidth)} ${this.theme.fg("border", "│")}`;

    lines.push(this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`));
    lines.push(row(`${this.theme.fg("toolTitle", this.theme.bold ? this.theme.bold(this.record.currentName) : this.record.currentName)} ${this.theme.fg("dim", `(${this.record.info.id.slice(0, 8)})`)}`));
    lines.push(row(this.theme.fg("dim", `${this.record.status} · ${this.record.invocationChain.join(" -> ") || this.record.currentName}`)));
    lines.push(row(this.theme.fg("dim", this.record.info.path)));
    lines.push(row(this.theme.fg("dim", "─".repeat(innerWidth))));

    const contentLines = this.buildContentLines(innerWidth);
    const viewport = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewport);
    if (this.autoFollow) this.scrollOffset = maxScroll;
    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visibleLines = contentLines.slice(visibleStart, visibleStart + viewport);
    for (let index = 0; index < viewport; index++) {
      lines.push(row(visibleLines[index] ?? ""));
    }

    lines.push(row(this.theme.fg("dim", "─".repeat(innerWidth))));
    lines.push(row(this.theme.fg("dim", `${contentLines.length} lines · ${this.autoFollow ? "follow" : "manual"} · f toggle follow · q close`)));
    lines.push(this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribe?.();
  }

  private viewportHeight(): number {
    return Math.max(6, Math.floor(this.tui.terminal.rows * 0.6) - 6);
  }

  private buildContentLines(width: number): string[] {
    const live = subagentActivityStore.get(this.record.info.id);
    const messages = live?.session?.messages ?? this.snapshotManager.buildSessionContext().messages;
    const lines = buildTranscriptLines(messages, {
      responseText: live?.currentResponseText,
      activeTools: live?.activeTools,
      maxToolResultChars: VIEWER_MAX_TOOL_RESULT_CHARS,
    });
    if (lines.length === 0) return [this.theme.fg("dim", "(no conversation yet)")];

    const rendered: string[] = [];
    for (const line of lines) {
      const colored = colorizeLine(line, this.theme);
      const wrapped = wrapTextWithAnsi(colored, Math.max(1, width));
      rendered.push(...(wrapped.length > 0 ? wrapped : [""]));
    }
    return rendered;
  }
}
