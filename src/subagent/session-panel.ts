import {
  AssistantMessageComponent,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
  type AgentSessionEvent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  type KeybindingsManager,
  Spacer,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { SubagentNode } from "./registry.js";
import type {
  SubagentActiveTool,
  SubagentAssistantMessage,
  SubagentViewMessage,
  SubagentViewSource,
} from "./runner.js";

const PANEL_MARGIN_ROWS = 2;

type ToolEndEvent = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

function userText(message: Extract<SubagentViewMessage, { role: "user" }>): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function padToWidth(value: string, width: number): string {
  const clipped = truncateToWidth(value, width, "…");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function borderLine(theme: Theme, left: string, label: string, right: string, width: number): string {
  const fixedWidth = visibleWidth(left) + visibleWidth(right);
  const available = Math.max(0, width - fixedWidth);
  const clippedLabel = truncateToWidth(label, available, "…");
  const fill = "─".repeat(Math.max(0, available - visibleWidth(clippedLabel)));
  return theme.fg("borderAccent", `${left}${clippedLabel}${fill}${right}`);
}

export class SubagentSessionPanel implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: () => void;
  private readonly sessionId: string;
  private readonly source: SubagentViewSource;
  private readonly getNode: () => SubagentNode | undefined;
  private readonly transcript = new Container();
  private readonly pendingTools = new Map<string, ToolExecutionComponent>();
  private readonly toolComponents = new Set<ToolExecutionComponent>();
  private streamingComponent: AssistantMessageComponent | undefined;
  private toolsExpanded = false;
  private followTail = true;
  private scrollTop = 0;
  private lastMaxScroll = 0;
  private lastViewportHeight = 1;
  private closed = false;
  private readonly unsubscribeSession: () => void;
  private readonly unsubscribeRegistry: () => void;

  constructor(options: {
    tui: TUI;
    theme: Theme;
    keybindings: KeybindingsManager;
    done: () => void;
    sessionId: string;
    source: SubagentViewSource;
    getNode: () => SubagentNode | undefined;
    subscribeRegistry: (listener: () => void) => () => void;
  }) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.done = options.done;
    this.sessionId = options.sessionId;
    this.source = options.source;
    this.getNode = options.getNode;
    this.rebuildFromSnapshot();
    this.unsubscribeSession = this.source.subscribe((event) => this.handleSessionEvent(event));
    this.unsubscribeRegistry = options.subscribeRegistry(() => this.tui.requestRender());
  }

  private createTool(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent {
    const component = new ToolExecutionComponent(
      toolName,
      toolCallId,
      args,
      { showImages: true },
      this.source.getToolDefinition(toolName),
      this.tui,
      this.source.cwd,
    );
    component.setExpanded(this.toolsExpanded);
    this.toolComponents.add(component);
    return component;
  }

  private addUserMessage(message: Extract<SubagentViewMessage, { role: "user" }>): void {
    const text = userText(message);
    if (!text) return;
    if (this.transcript.children.length > 0) this.transcript.addChild(new Spacer(1));
    this.transcript.addChild(new UserMessageComponent(text, getMarkdownTheme(), 0));
  }

  private addAssistantMessage(message: SubagentAssistantMessage): void {
    const component = new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking...", 0);
    this.transcript.addChild(component);
    for (const content of message.content) {
      if (content.type !== "toolCall") continue;
      const tool = this.createTool(content.name, content.id, content.arguments);
      this.transcript.addChild(tool);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        tool.updateResult({
          content: [{ type: "text", text: message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error") }],
          isError: true,
        });
      } else {
        tool.setArgsComplete();
        this.pendingTools.set(content.id, tool);
      }
    }
  }

  private applyActiveTool(snapshot: SubagentActiveTool): void {
    let component = this.pendingTools.get(snapshot.toolCallId);
    if (!component) {
      component = this.createTool(snapshot.toolName, snapshot.toolCallId, snapshot.args);
      this.transcript.addChild(component);
      this.pendingTools.set(snapshot.toolCallId, component);
    } else {
      component.updateArgs(snapshot.args);
    }
    if (snapshot.executionStarted) component.markExecutionStarted();
    if (snapshot.argsComplete) component.setArgsComplete();
    if (snapshot.partialResult !== undefined) component.updateResult({ ...snapshot.partialResult, isError: false }, true);
  }

  private rebuildFromSnapshot(): void {
    this.transcript.clear();
    this.pendingTools.clear();
    this.toolComponents.clear();
    for (const message of this.source.getMessages()) {
      if (message.role === "user") {
        this.addUserMessage(message);
      } else if (message.role === "assistant") {
        this.addAssistantMessage(message);
      } else if (message.role === "toolResult") {
        const component = this.pendingTools.get(message.toolCallId);
        if (component) {
          component.updateResult(message);
          this.pendingTools.delete(message.toolCallId);
        }
      }
    }

    const streamingMessage = this.source.getStreamingMessage();
    if (streamingMessage) {
      this.streamingComponent = new AssistantMessageComponent(streamingMessage, false, getMarkdownTheme(), "Thinking...", 0);
      this.transcript.addChild(this.streamingComponent);
      for (const content of streamingMessage.content) {
        if (content.type !== "toolCall" || this.pendingTools.has(content.id)) continue;
        const component = this.createTool(content.name, content.id, content.arguments);
        this.transcript.addChild(component);
        this.pendingTools.set(content.id, component);
      }
    }
    for (const tool of this.source.getActiveTools()) this.applyActiveTool(tool);
  }

  private ensureStreamingTool(toolCallId: string, toolName: string, args: unknown): ToolExecutionComponent {
    let component = this.pendingTools.get(toolCallId);
    if (!component) {
      component = this.createTool(toolName, toolCallId, args);
      this.transcript.addChild(component);
      this.pendingTools.set(toolCallId, component);
    } else {
      component.updateArgs(args);
    }
    return component;
  }

  private handleToolEnd(event: ToolEndEvent): void {
    const component = this.pendingTools.get(event.toolCallId);
    if (!component) return;
    component.updateResult({ ...event.result, isError: event.isError });
    this.pendingTools.delete(event.toolCallId);
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    if (this.closed) return;
    if (event.type === "message_start") {
      if (event.message.role === "user") {
        this.addUserMessage(event.message);
      } else if (event.message.role === "assistant") {
        this.streamingComponent = new AssistantMessageComponent(event.message, false, getMarkdownTheme(), "Thinking...", 0);
        this.transcript.addChild(this.streamingComponent);
      }
    } else if (event.type === "message_update" && event.message.role === "assistant") {
      if (!this.streamingComponent) {
        this.streamingComponent = new AssistantMessageComponent(event.message, false, getMarkdownTheme(), "Thinking...", 0);
        this.transcript.addChild(this.streamingComponent);
      } else {
        this.streamingComponent.updateContent(event.message);
      }
      for (const content of event.message.content) {
        if (content.type === "toolCall") this.ensureStreamingTool(content.id, content.name, content.arguments);
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      this.streamingComponent?.updateContent(event.message);
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        const errorText = event.message.errorMessage || (event.message.stopReason === "aborted" ? "Operation aborted" : "Error");
        for (const component of this.pendingTools.values()) {
          component.updateResult({ content: [{ type: "text", text: errorText }], isError: true });
        }
        this.pendingTools.clear();
      } else {
        for (const content of event.message.content) {
          if (content.type !== "toolCall") continue;
          const component = this.ensureStreamingTool(content.id, content.name, content.arguments);
          component.setArgsComplete();
        }
      }
      this.streamingComponent = undefined;
    } else if (event.type === "tool_execution_start") {
      this.ensureStreamingTool(event.toolCallId, event.toolName, event.args).markExecutionStarted();
    } else if (event.type === "tool_execution_update") {
      const component = this.ensureStreamingTool(event.toolCallId, event.toolName, event.args);
      component.markExecutionStarted();
      component.updateResult({ ...event.partialResult, isError: false }, true);
    } else if (event.type === "tool_execution_end") {
      this.handleToolEnd(event);
    }
    this.tui.requestRender();
  }

  private moveScroll(delta: number): void {
    this.followTail = false;
    this.scrollTop = Math.max(0, Math.min(this.lastMaxScroll, this.scrollTop + delta));
    if (this.scrollTop >= this.lastMaxScroll) this.followTail = true;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveScroll(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveScroll(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.moveScroll(-this.lastViewportHeight);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveScroll(this.lastViewportHeight);
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorLineStart")) {
      this.followTail = false;
      this.scrollTop = 0;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorLineEnd")) {
      this.followTail = true;
      this.scrollTop = this.lastMaxScroll;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "app.tools.expand")) {
      this.toolsExpanded = !this.toolsExpanded;
      for (const component of this.toolComponents) component.setExpanded(this.toolsExpanded);
      this.tui.requestRender();
    }
  }

  invalidate(): void {
    this.transcript.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    const innerWidth = Math.max(1, safeWidth - 2);
    const maxHeight = Math.max(4, this.tui.terminal.rows - PANEL_MARGIN_ROWS);
    const viewportHeight = Math.max(1, maxHeight - 3);
    const contentLines = this.transcript.render(innerWidth);
    if (contentLines.length === 0) contentLines.push(this.theme.fg("muted", "Waiting for subagent output..."));
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    if (this.followTail) this.scrollTop = maxScroll;
    else this.scrollTop = Math.min(this.scrollTop, maxScroll);
    this.lastMaxScroll = maxScroll;
    this.lastViewportHeight = viewportHeight;

    const node = this.getNode();
    const status = node?.status ?? this.source.status ?? "finished";
    const agentType = node?.agentType ?? this.source.agentType ?? "unknown";
    const turns = node?.turns ?? this.source.turns ?? 0;
    const toolCount = node?.toolCount ?? this.source.toolCount ?? 0;
    const title = ` subagent ${agentType} · ${status} · turns: ${turns} · tool calls: ${toolCount} `;
    const footer = this.followTail
      ? " Esc close · ↑/↓ scroll · PgUp/PgDn · Home/End · Ctrl+O expand "
      : " Esc close · End follow latest · ↑/↓ scroll · PgUp/PgDn · Ctrl+O expand ";
    const visible = contentLines.slice(this.scrollTop, this.scrollTop + viewportHeight);
    while (visible.length < viewportHeight) visible.push("");

    return [
      borderLine(this.theme, "╭─", title, "╮", safeWidth),
      ...visible.map((line) => `${this.theme.fg("borderAccent", "│")}${padToWidth(line, innerWidth)}${this.theme.fg("borderAccent", "│")}`),
      borderLine(this.theme, "├─", footer, "┤", safeWidth),
      borderLine(this.theme, "╰─", ` session ${this.sessionId} `, "╯", safeWidth),
    ];
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeSession();
    this.unsubscribeRegistry();
  }
}
