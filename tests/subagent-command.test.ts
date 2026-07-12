import { mkdir } from "node:fs/promises";
import {
  initTheme,
  SessionManager,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_STATE_ENTRY } from "../src/agent-support.js";
import { registerSubagentCommand } from "../src/subagent/command.js";
import { subagentRegistry } from "../src/subagent/registry.js";
import {
  runSubagent,
  subagentSessionDir,
  type SubagentSession,
  type SubagentViewSource,
} from "../src/subagent/runner.js";
import { createTempWorkspace } from "./helpers.js";

initTheme("dark", false);

type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
type OverlayFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: void) => void,
) => Component & { dispose?: () => void };

function captureCommand(): Command {
  let command: Command | undefined;
  registerSubagentCommand({
    registerCommand(_name: string, value: unknown) {
      command = value as Command;
    },
  } as never);
  if (!command) throw new Error("subagent command was not registered");
  return command;
}

function createContext(
  cwd: string,
  custom: (factory: OverlayFactory, options?: unknown) => Promise<void>,
  notifications: string[],
): ExtensionCommandContext {
  return {
    hasUI: true,
    mode: "tui",
    cwd,
    sessionManager: {
      getSessionId: () => "root",
      getEntries: () => [],
    },
    ui: {
      custom,
      notify: (message: string) => notifications.push(message),
    },
  } as never;
}

function renderOverlay(factory: OverlayFactory): Component & { dispose?: () => void } {
  return factory(
    { terminal: { rows: 24 }, requestRender: () => undefined } as never,
    { fg: (_color: string, text: string) => text } as never,
    { matches: () => false } as never,
    () => undefined,
  );
}

async function createPersistedSession(cwd: string, sessionId: string): Promise<void> {
  const sessionDir = subagentSessionDir(cwd);
  await mkdir(sessionDir, { recursive: true });
  const session = SessionManager.create(cwd, sessionDir, { id: sessionId });
  session.appendCustomEntry(AGENT_STATE_ENTRY, { name: "explorer" });
  session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "inspect persisted state" }],
  } as never);
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "finished report" }],
    provider: "actual-provider",
    model: "actual-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    stopReason: "stop",
  } as never);
  session.appendModelChange("selected-provider", "selected-but-unused-model");
}

afterEach(() => subagentRegistry.clear());

describe("/subagent", () => {
  it("always selects before opening a running session", async () => {
    // Intent: bare /subagent has one selector path regardless of the number of running children.
    const command = captureCommand();
    let releasePrompt = (): void => undefined;
    const pendingPrompt = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
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
      prompt: () => pendingPrompt,
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
    subagentRegistry.update("child-live", {
      lastActivity: `→ task ${JSON.stringify({ subagent_type: "explorer", prompt: "x".repeat(200) })}`,
    });

    let overlayOptions: unknown;
    const custom = async (factory: OverlayFactory, options?: unknown): Promise<void> => {
      overlayOptions = options;
      const component = renderOverlay(factory);
      try {
        const selectorLines = component.render(60);
        const selectorOutput = selectorLines.join("\n");
        expect(selectorLines).toHaveLength(9);
        expect(selectorLines.every((line) => visibleWidth(line) <= 60)).toBe(true);
        expect(selectorOutput).toContain("View subagent");
        expect(selectorOutput).toContain("explorer · running");
        expect(selectorOutput).toContain("…");
        expect(selectorOutput).not.toContain("subagent explorer · running");
        component.handleInput?.("\n");
        expect(component.render(80).join("\n")).toContain("subagent explorer · running");
      } finally {
        component.dispose?.();
      }
    };
    const notifications: string[] = [];
    try {
      await command.handler("", createContext("/tmp/work", custom, notifications));
      expect(overlayOptions).toMatchObject({
        overlay: true,
        overlayOptions: {
          width: "100%",
          maxHeight: "100%",
          anchor: "bottom-center",
          margin: { top: 1, right: 0, bottom: 1, left: 0 },
        },
      });
      expect(notifications).toEqual([]);
      expect(child.abort).not.toHaveBeenCalled();
      expect(child.dispose).not.toHaveBeenCalled();
    } finally {
      releasePrompt();
      await runPromise;
    }
    expect(child.dispose).toHaveBeenCalledTimes(1);
  });

  it("opens the persisted transcript when a selected running session finishes", async () => {
    // Intent: selector and explicit-id entry share the same live-to-persisted resolution path.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await createTempWorkspace();
    const cwd = await createTempWorkspace();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await createPersistedSession(cwd, "race-child");
      let releasePrompt = (): void => undefined;
      const pendingPrompt = new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      const source: SubagentViewSource = {
        cwd,
        getMessages: () => [],
        getStreamingMessage: () => undefined,
        getActiveTools: () => [],
        getToolDefinition: () => undefined,
        subscribe: () => () => undefined,
      };
      const child: SubagentSession = {
        sessionId: "race-child",
        prompt: () => pendingPrompt,
        collect: () => ({ report: "done", toolCount: 0 }),
        view: source,
        abort: vi.fn(),
        dispose: vi.fn(),
      };
      const runPromise = runSubagent(
        { cwd, sessionManager: { getSessionId: () => "root", getEntries: () => [] } } as never,
        { agentType: "explorer", prompt: "inspect", childDepth: 2 },
        { spawn: async () => child, resume: async () => child },
      );
      await Promise.resolve();
      await Promise.resolve();

      const command = captureCommand();
      const notifications: string[] = [];
      const custom = async (factory: OverlayFactory): Promise<void> => {
        const component = renderOverlay(factory);
        try {
          expect(component.render(80).join("\n")).toContain("explorer · running");
          releasePrompt();
          await runPromise;
          expect(component.render(80).join("\n")).toContain("explorer · done");
          component.handleInput?.("\n");
          const output = component.render(80).join("\n");
          expect(output).toContain("subagent explorer · done · model: actual-provider/actual-model");
          expect(output).toContain("finished report");
          expect(output).toContain("session race-child");
        } finally {
          releasePrompt();
          await runPromise;
          component.dispose?.();
        }
      };

      await command.handler("", createContext(cwd, custom, notifications));
      expect(notifications).toEqual([]);
      expect(child.dispose).toHaveBeenCalledTimes(1);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("opens a completed persisted session directly by explicit id", async () => {
    // Intent: completed children remain inspectable without recreating or taking ownership of AgentSession.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await createTempWorkspace();
    const cwd = await createTempWorkspace();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await createPersistedSession(cwd, "completed-child");

      const command = captureCommand();
      const notifications: string[] = [];
      const custom = async (factory: OverlayFactory): Promise<void> => {
        const component = renderOverlay(factory);
        try {
          const output = component.render(120).join("\n");
          expect(output).not.toContain("View subagent");
          expect(output).toContain("subagent explorer · done · model: actual-provider/actual-model · turns: 1 · tool calls: 0");
          expect(output).toContain("finished report");
          expect(output).toContain("session completed-child");
        } finally {
          component.dispose?.();
        }
      };

      await command.handler("completed-child", createContext(cwd, custom, notifications));
      expect(notifications).toEqual([]);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});
