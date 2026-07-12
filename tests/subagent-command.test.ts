import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSubagentCommand } from "../src/subagent/command.js";
import { subagentRegistry } from "../src/subagent/registry.js";
import { runSubagent, type SubagentSession, type SubagentViewSource } from "../src/subagent/runner.js";

afterEach(() => subagentRegistry.clear());

describe("/subagent", () => {
  it("opens a full-size overlay for a running child and leaves execution owned by the runner", async () => {
    // Intent: the command must observe the existing live session instead of opening or replacing it.
    let command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
    registerSubagentCommand({
      registerCommand(_name: string, value: unknown) {
        command = value as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
      },
    } as never);

    let releasePrompt: (() => void) | undefined;
    const source: SubagentViewSource = {
      cwd: "/tmp/work",
      getMessages: () => [],
      getStreamingMessage: () => undefined,
      getActiveTools: () => [],
      getToolDefinition: () => undefined,
      subscribe: () => () => undefined,
    };
    const child: SubagentSession = {
      sessionId: "child-live",
      prompt: () => new Promise<void>((resolve) => {
        releasePrompt = resolve;
      }),
      collect: () => ({ report: "done", toolCount: 0 }),
      view: source,
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    const runPromise = runSubagent(
      { cwd: "/tmp/work", sessionManager: { getSessionId: () => "root", getEntries: () => [] } } as never,
      { agentType: "explorer", prompt: "inspect", childDepth: 2 },
      { spawn: async () => child, resume: async () => child },
    );
    await Promise.resolve();
    await Promise.resolve();

    let overlayOptions: unknown;
    const custom = async (
      factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: void) => void) => Component & { dispose?: () => void },
      options?: unknown,
    ): Promise<void> => {
      overlayOptions = options;
      const component = factory(
        { terminal: { rows: 24 }, requestRender: () => undefined } as never,
        { fg: (_color: string, text: string) => text } as never,
        { matches: () => false } as never,
        () => undefined,
      );
      expect(component.render(80).join("\n")).toContain("subagent explorer · running");
      component.dispose?.();
    };
    const notifications: string[] = [];
    await command?.handler("child-live", {
      hasUI: true,
      mode: "tui",
      cwd: "/tmp/work",
      sessionManager: {
        getSessionId: () => "root",
        getEntries: () => [],
      },
      ui: {
        custom,
        notify: (message: string) => notifications.push(message),
      },
    } as never);

    expect(overlayOptions).toMatchObject({
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", margin: { top: 1, right: 0, bottom: 1, left: 0 } },
    });
    expect(notifications).toEqual([]);
    expect(child.abort).not.toHaveBeenCalled();
    expect(child.dispose).not.toHaveBeenCalled();

    releasePrompt?.();
    await runPromise;
    expect(child.dispose).toHaveBeenCalledTimes(1);
  });
});
