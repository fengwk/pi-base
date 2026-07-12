import { initTheme, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SubagentViewMessage, SubagentViewSource } from "../src/subagent/runner.js";
import { SubagentSessionPanel } from "../src/subagent/session-panel.js";

initTheme("dark", false);

function createHarness(initialMessages: readonly SubagentViewMessage[] = []) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const requestRender = vi.fn();
  const done = vi.fn();
  const unsubscribeRegistry = vi.fn();
  const source: SubagentViewSource = {
    cwd: "/tmp/work",
    getModel: () => ({ provider: "minimax-cn", modelId: "MiniMax-M3" }),
    getMessages: () => initialMessages,
    getStreamingMessage: () => undefined,
    getActiveTools: () => [],
    getToolDefinition: () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
    tui: { terminal: { rows: 12 }, requestRender } as never,
    theme: { fg: (_color: string, text: string) => text } as never,
    keybindings: { matches: (data: string, binding: string) => bindings.get(data) === binding } as never,
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
  it("renders live assistant text and tool execution with the main Pi components", () => {
    // Intent: the overlay must consume the same message/tool event stream as the main chat renderer.
    const harness = createHarness();
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
    expect(output).toContain("subagent explorer · running · model: minimax-cn/MiniMax-M3 · turns: 1 · tool calls: 1");
    expect(output).toContain("Inspecting files");
    expect(output).toContain("read");
    expect(harness.requestRender).toHaveBeenCalled();
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
    expect(harness.panel.render(50).join("\n")).toContain("End follow latest");
    harness.panel.handleInput("end");
    expect(harness.panel.render(50).join("\n")).not.toContain("End follow latest");
    harness.panel.handleInput("cancel");
    expect(harness.done).toHaveBeenCalledTimes(1);

    harness.panel.dispose();
    expect(harness.unsubscribeRegistry).toHaveBeenCalledTimes(1);
  });
});
