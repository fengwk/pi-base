import { initTheme, ToolExecutionComponent, type AgentSessionEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { SubagentViewMessage, SubagentViewSource } from "../src/subagent/runner.js";
import { SubagentSessionPanel, type SubagentViewportKeybindings } from "../src/subagent/session-panel.js";

initTheme("dark", false);

function createHarness(
  initialMessages: readonly SubagentViewMessage[] = [],
  sourceOverrides: Partial<SubagentViewSource> = {},
  viewportKeybindings?: SubagentViewportKeybindings,
  rows = 12,
) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const requestRender = vi.fn();
  const done = vi.fn();
  const unsubscribeRegistry = vi.fn();
  const source: SubagentViewSource = {
    cwd: "/tmp/work",
    getModel: () => ({ provider: "minimax-cn", modelId: "MiniMax-M3" }),
    getThinkingLevel: () => "high",
    getMessages: () => initialMessages,
    getStreamingMessage: () => undefined,
    getActiveTools: () => [],
    getCompletedTools: () => [],
    getToolDefinition: () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...sourceOverrides,
  };
  const bindings = new Map([
    ["cancel", "tui.select.cancel"],
    ["up", "tui.select.up"],
    ["down", "tui.select.down"],
    ["page-up", "tui.select.pageUp"],
    ["page-down", "tui.select.pageDown"],
    ["home", "tui.editor.cursorLineStart"],
    ["end", "tui.editor.cursorLineEnd"],
    ["expand", "app.tools.expand"],
  ]);
  const panel = new SubagentSessionPanel({
    tui: { terminal: { rows }, requestRender } as never,
    theme: { fg: (_color: string, text: string) => text } as never,
    keybindings: {
      matches: (data: string, binding: string) => bindings.get(data) === binding,
      getKeys: () => [],
    } as never,
    done,
    sessionId: "child-1",
    source,
    getNode: () => ({
      sessionId: "child-1",
      parentSessionId: "root",
      rootSessionId: "root",
      agentType: "explorer",
      depth: 2,
      status: "running",
      turns: 1,
      toolCount: 1,
      startedAt: 1,
    }),
    subscribeRegistry: () => unsubscribeRegistry,
    viewportKeybindings,
  });
  return {
    panel,
    done,
    requestRender,
    unsubscribeRegistry,
    emit(event: AgentSessionEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

describe("SubagentSessionPanel", () => {
  it.each([false, true])("expands missing historical definitions with SDK defaults (error=%s)", (isError) => {
    // Real SDK components prove that an unknown historical tool no longer uses the
    // fixed generic truncation path, including arguments, errors and image content.
    const updateResult = vi.spyOn(ToolExecutionComponent.prototype, "updateResult");
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "historical", name: "removed-tool", arguments: { path: "args-sentinel" } }],
        stopReason: "toolUse", timestamp: 1,
      },
      {
        role: "toolResult", toolCallId: "historical", toolName: "removed-tool",
        content: [
          { type: "text", text: Array.from({ length: 15 }, (_, i) => `result-line-${i + 1}-end`).join("\n") },
          { type: "image", data: "", mimeType: "image/png" },
        ],
        isError, timestamp: 2,
      },
    ] as unknown as SubagentViewMessage[];
    const harness = createHarness(messages, {}, undefined, 60);
    try {
      const collapsed = harness.panel.render(120).join("\n");
      expect(collapsed).toContain("args-sentinel");
      expect(collapsed).toContain("result-line-10-end");
      expect(collapsed).not.toContain("result-line-11-end");
      // The SDK appends one image fallback line to the 15 text lines.
      expect(collapsed).toContain("6 more lines");
      expect(updateResult).toHaveBeenCalledWith(messages[1]);
      harness.panel.handleInput("expand");
      const expanded = harness.panel.render(120).join("\n");
      expect(expanded).toContain("result-line-15-end");
      expect(expanded).toContain("path: args-sentinel");
      expect(expanded).toContain("image/png");
      expect(expanded).not.toContain("more lines");
      harness.panel.handleInput("expand");
      expect(harness.panel.render(120).join("\n")).toBe(collapsed);
    } finally {
      harness.panel.dispose();
      updateResult.mockRestore();
    }
  });

  it("preserves existing definitions and custom SDK renderers", () => {
    // Nullish fallback must not replace either custom renderer or its render context.
    const renderCall = vi.fn(() => new Text("custom call", 0, 0));
    const renderResult = vi.fn((_result, options) => new Text(`custom result expanded=${options.expanded}`, 0, 0));
    const execute = vi.fn();
    const definition: ToolDefinition = {
      name: "known", label: "Known", description: "", parameters: Type.Object({}),
      execute, renderCall, renderResult,
    };
    const harness = createHarness([], { getToolDefinition: () => definition }, undefined, 40);
    try {
      harness.emit({ type: "tool_execution_start", toolCallId: "known-call", toolName: "known", args: { value: 7 } });
      harness.emit({
        type: "tool_execution_end", toolCallId: "known-call", toolName: "known",
        result: { content: [{ type: "text", text: "result" }], details: { value: 8 } }, isError: true,
      });
      expect(harness.panel.render(120).join("\n")).toContain("custom result expanded=false");
      harness.panel.handleInput("expand");
      expect(harness.panel.render(120).join("\n")).toContain("custom result expanded=true");
      expect(renderCall).toHaveBeenCalledWith({ value: 7 }, expect.anything(), expect.objectContaining({ expanded: true }));
      expect(renderResult).toHaveBeenLastCalledWith(
        { content: [{ type: "text", text: "result" }], details: { value: 8 } },
        { expanded: true, isPartial: false }, expect.anything(), expect.objectContaining({ isError: true }),
      );
      expect(execute).not.toHaveBeenCalled();
    } finally {
      harness.panel.dispose();
    }
  });

  it("renders live assistant text and tool execution with the main Pi components", () => {
    // Intent: the overlay must consume the same message/tool event stream as the main chat renderer.
    const harness = createHarness([], {}, undefined, 24);
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "Inspecting files" }],
      stopReason: "stop",
      timestamp: Date.now(),
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } as never;
    harness.emit({ type: "message_start", message: assistant });
    harness.emit({ type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" } } as never);
    harness.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "src/a.ts" } });
    harness.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "1|alpha" }], details: undefined },
      isError: false,
    });

    const output = harness.panel.render(120).join("\n");
    expect(output).toContain("subagent explorer · running · minimax-cn/MiniMax-M3 · thinking: high · turns: 1 · tool calls: 1");
    expect(output).toContain("Inspecting files");
    expect(output).toContain("read");
    expect(output).not.toContain("├─");
    expect(harness.requestRender).toHaveBeenCalled();
  });

  it("replays completed parallel tools when opened while a sibling is still running", () => {
    // Intent: a panel opened after one parallel tool ended must use the live completion snapshot;
    // the core delays persisted toolResult messages until every sibling finishes.
    const initialMessages = [{
      role: "assistant",
      content: [
        { type: "toolCall", id: "finished-call", name: "finished-tool", arguments: { value: "a" } },
        { type: "toolCall", id: "running-call", name: "running-tool", arguments: { value: "b" } },
      ],
      stopReason: "toolUse",
      timestamp: 1,
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }] as never;
    const harness = createHarness(initialMessages, {
      getCompletedTools: () => [{
        toolCallId: "finished-call",
        result: { content: [{ type: "text", text: "finished result" }], details: undefined },
        isError: false,
      }],
      getActiveTools: () => [{
        toolCallId: "running-call",
        toolName: "running-tool",
        args: { value: "b" },
        executionStarted: true,
        argsComplete: true,
      }],
    });

    harness.panel.handleInput("home");
    expect(harness.panel.render(120).join("\n")).toContain("finished result");
  });

  it("settles a pending tool from its persisted result when the execution-end event was missed", () => {
    // Intent: the persisted message is the final fallback if a live panel did not observe
    // tool_execution_end, so the card must not remain pending until the panel is reopened.
    const harness = createHarness([{
      role: "assistant",
      content: [{ type: "toolCall", id: "missed-call", name: "missed-tool", arguments: { value: "a" } }],
      stopReason: "toolUse",
      timestamp: 1,
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }] as never);
    harness.emit({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "missed-call",
        toolName: "missed-tool",
        content: [{ type: "text", text: "persisted fallback result" }],
        details: undefined,
        isError: false,
        timestamp: 2,
      },
    } as never);
    expect(harness.panel.render(120).join("\n")).toContain("persisted fallback result");
  });

  it("rebuilds persisted and active tool state, then handles live error and navigation events", () => {
    // Intent: reopening a panel must reconstruct tool state and continue consuming every live update path.
    const initialMessages = [
      { role: "user", content: "inspect the file", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "saved-call", name: "read", arguments: { path: "saved.ts" } }],
        stopReason: "toolUse",
        timestamp: 2,
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
      { role: "toolResult", toolCallId: "saved-call", toolName: "read", content: [{ type: "text", text: "saved result" }], isError: false, timestamp: 3 },
    ] as never;
    const streaming = {
      role: "assistant",
      content: [
        { type: "text", text: "working" },
        { type: "toolCall", id: "stream-call", name: "grep", arguments: { pattern: "x" } },
      ],
      stopReason: "toolUse",
      timestamp: 4,
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const harness = createHarness(initialMessages, {
      getStreamingMessage: () => streaming as never,
      getActiveTools: () => [{
        toolCallId: "stream-call",
        toolName: "grep",
        args: { pattern: "updated" },
        executionStarted: true,
        argsComplete: true,
        partialResult: { content: [{ type: "text", text: "partial" }], details: undefined },
      }],
    });

    harness.panel.render(100);
    harness.panel.handleInput("home");
    expect(harness.panel.render(100).join("\n")).toContain("inspect the file");
    harness.panel.handleInput("end");
    harness.emit({ type: "message_end", message: streaming } as never);
    const failed = {
      ...streaming,
      content: [{ type: "toolCall", id: "failed-call", name: "write", arguments: { path: "a.ts" } }],
      stopReason: "error",
      errorMessage: "write failed",
    } as never;
    harness.emit({ type: "message_update", message: failed, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" } } as never);
    harness.emit({
      type: "tool_execution_update",
      toolCallId: "failed-call",
      toolName: "write",
      args: { path: "a.ts" },
      partialResult: { content: [{ type: "text", text: "writing" }], details: undefined },
    });
    harness.emit({ type: "message_end", message: failed } as never);
    expect(harness.panel.render(100).join("\n")).toContain("write failed");

    for (const key of ["down", "page-up", "page-down", "home", "expand"]) harness.panel.handleInput(key);
    harness.panel.invalidate();
    harness.panel.dispose();
    harness.panel.dispose();
    expect(harness.unsubscribeRegistry).toHaveBeenCalledTimes(1);
  });

  it("stops following the tail while scrolling and cleans up on close", () => {
    // Intent: inspecting older output must remain stable while live events continue, and closing only unsubscribes the view.
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: "user",
      content: [{ type: "text", text: `message ${index}` }],
      timestamp: index,
    })) as never;
    const harness = createHarness(messages);
    harness.panel.render(50);
    harness.panel.handleInput("up");
    harness.emit({
      type: "message_start",
      message: { role: "user", content: "new tail sentinel", timestamp: 9 },
    } as never);
    expect(harness.panel.render(50).join("\n")).not.toContain("new tail sentinel");
    harness.panel.handleInput("end");
    expect(harness.panel.render(50).join("\n")).toContain("new tail sentinel");
    harness.panel.handleInput("cancel");
    expect(harness.done).toHaveBeenCalledTimes(1);

    harness.panel.dispose();
    expect(harness.unsubscribeRegistry).toHaveBeenCalledTimes(1);
  });

  it("uses configured fullscreen viewport keys for page and edge navigation", () => {
    // Intent: fullscreen key customizations must remain usable inside the overlay after Pi's viewport claims are scoped away.
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: "user",
      content: [{ type: "text", text: `message ${index}` }],
      timestamp: index,
    })) as never;
    const harness = createHarness(messages, {}, {
      pageUp: ["ctrl+pageUp"],
      pageDown: ["ctrl+pageDown"],
      halfPageUp: ["ctrl+u"],
      halfPageDown: ["ctrl+d"],
      lineUp: ["ctrl+up"],
      lineDown: ["ctrl+down"],
      top: ["ctrl+home"],
      bottom: ["ctrl+end"],
    });

    harness.panel.render(120);
    harness.panel.handleInput("\x1b[1;5H");
    const atTop = harness.panel.render(200).join("\n");
    expect(atTop).toContain("message 0");
    expect(atTop).not.toContain("ctrl+pageUp");
    expect(atTop).not.toContain("ctrl+end");
    expect(atTop).not.toContain("half-page");

    harness.panel.handleInput("\x04");
    expect(harness.panel.render(120).join("\n")).not.toContain("message 0");
    harness.panel.handleInput("\x15");
    expect(harness.panel.render(120).join("\n")).toContain("message 0");
    harness.panel.handleInput("\x1b[6;5~");
    expect(harness.panel.render(120).join("\n")).not.toContain("message 0");
    harness.panel.handleInput("\x1b[5;5~");
    const atTopAfterPage = harness.panel.render(120).join("\n");
    expect(atTopAfterPage).toContain("message 0");
    harness.panel.handleInput("\x1b[1;5B");
    const afterLineDown = harness.panel.render(120).join("\n");
    expect(afterLineDown).not.toBe(atTopAfterPage);
    harness.panel.handleInput("\x1b[1;5A");
    expect(harness.panel.render(120).join("\n")).toBe(atTopAfterPage);
    harness.panel.handleInput("\x1b[1;5F");
    expect(harness.panel.render(120).join("\n")).toContain("message 7");
  });

  it("keeps following new output when top is pressed before scrolling is possible", () => {
    // Intent: top on a short transcript must preserve the same follow-tail semantics as Pi's ScrollView.
    const harness = createHarness(
      [{ role: "user", content: "initial", timestamp: 1 }] as never,
      {},
      {
        pageUp: [],
        pageDown: [],
        halfPageUp: [],
        halfPageDown: [],
        lineUp: [],
        lineDown: [],
        top: ["ctrl+home"],
        bottom: ["ctrl+end"],
      },
    );
    harness.panel.render(120);
    harness.panel.handleInput("\x1b[1;5H");
    for (let index = 0; index < 8; index += 1) {
      harness.emit({
        type: "message_start",
        message: { role: "user", content: `new message ${index}`, timestamp: index + 2 },
      } as never);
    }

    const output = harness.panel.render(120).join("\n");
    expect(output).toContain("new message 7");
  });

  it("preserves regular-mode Home behavior on a short transcript", () => {
    // Intent: the fullscreen ScrollView alignment must not change the existing regular-panel follow-tail behavior.
    const harness = createHarness([{ role: "user", content: "initial", timestamp: 1 }] as never);
    harness.panel.render(120);
    harness.panel.handleInput("home");
    for (let index = 0; index < 8; index += 1) {
      harness.emit({
        type: "message_start",
        message: { role: "user", content: `new message ${index}`, timestamp: index + 2 },
      } as never);
    }

    const output = harness.panel.render(120).join("\n");
    expect(output).toContain("initial");
    expect(output).not.toContain("new message 7");
  });
});
