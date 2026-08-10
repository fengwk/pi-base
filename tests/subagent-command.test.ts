import { mkdir } from "node:fs/promises";
import {
  initTheme,
  SessionManager,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  type Terminal,
  type TUI,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
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

class TestTerminal implements Terminal {
  readonly columns = 120;
  readonly rows = 12;
  readonly kittyProtocolActive = false;
  private onInput: ((data: string) => void) | undefined;

  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }

  stop(): void {
    this.onInput = undefined;
  }

  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  sendInput(data: string): void {
    this.onInput?.(data);
  }
}

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

function renderOverlay(
  factory: OverlayFactory,
  options: {
    keybindings?: KeybindingsManager;
    tui?: TUI;
    done?: () => void;
  } = {},
): Component & { dispose?: () => void } {
  const keybindings = options.keybindings ?? {
    matches: () => false,
    getKeys: () => [],
    getUserBindings: () => ({}),
    setUserBindings: () => undefined,
  } as never;
  return factory(
    options.tui ?? { mode: "fullscreen", terminal: { rows: 24 }, requestRender: () => undefined } as never,
    { fg: (_color: string, text: string) => text } as never,
    keybindings,
    options.done ?? (() => undefined),
  );
}

async function createPersistedSession(cwd: string, sessionId: string, userMessageCount = 1): Promise<void> {
  const sessionDir = subagentSessionDir(cwd);
  await mkdir(sessionDir, { recursive: true });
  const session = SessionManager.create(cwd, sessionDir, { id: sessionId });
  session.appendCustomEntry(AGENT_STATE_ENTRY, { name: "explorer" });
  for (let index = 0; index < userMessageCount; index += 1) {
    session.appendMessage({
      role: "user",
      content: [{ type: "text", text: `inspect persisted state ${index}` }],
    } as never);
  }
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "finished report" }],
    provider: "actual-provider",
    model: "actual-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    stopReason: "stop",
  } as never);
  session.appendModelChange("selected-provider", "selected-but-unused-model");
  session.appendThinkingLevelChange("max");
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
      getCompletedTools: () => [],
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

    const originalBindings = {
      "tui.altScreen.pageUp": ["pageUp", "ctrl+alt+u"],
      "tui.altScreen.pageDown": ["pageDown", "ctrl+alt+d"],
      "tui.altScreen.halfPageUp": ["ctrl+u"],
      "tui.altScreen.halfPageDown": ["ctrl+d"],
      "tui.altScreen.previousPrompt": ["ctrl+shift+up"],
      "tui.altScreen.nextPrompt": ["ctrl+shift+down"],
      "tui.altScreen.top": ["home", "ctrl+alt+shift+u"],
      "tui.altScreen.bottom": ["end", "ctrl+alt+shift+d"],
    };
    let activeBindings: Record<string, string | string[]> = { ...originalBindings };
    const keybindings = {
      matches: () => false,
      getKeys: (binding: string) => {
        const keys = activeBindings[binding];
        return keys === undefined ? [] : Array.isArray(keys) ? [...keys] : [keys];
      },
      getUserBindings: () => ({ ...activeBindings }),
      setUserBindings: (next: Record<string, string | string[]>) => {
        activeBindings = { ...next };
      },
    } as never;
    let overlayOptions: unknown;
    const custom = async (factory: OverlayFactory, options?: unknown): Promise<void> => {
      overlayOptions = options;
      const component = renderOverlay(factory, { keybindings });
      try {
        expect(activeBindings).toEqual({
          ...originalBindings,
          "tui.altScreen.pageUp": [],
          "tui.altScreen.pageDown": [],
          "tui.altScreen.halfPageUp": [],
          "tui.altScreen.halfPageDown": [],
          "tui.altScreen.previousPrompt": [],
          "tui.altScreen.nextPrompt": [],
          "tui.altScreen.top": [],
          "tui.altScreen.bottom": [],
        });
        const selectorLines = component.render(60);
        const selectorOutput = selectorLines.join("\n");
        expect(selectorLines).toHaveLength(9);
        expect(selectorLines.every((line) => visibleWidth(line) <= 60)).toBe(true);
        expect(selectorOutput).toContain("View subagent");
        expect(selectorOutput).toContain("explorer · running");
        expect(selectorOutput).toContain("…");
        expect(selectorOutput).not.toContain("subagent explorer · running");
        for (const key of ["j", "k", "down", "up"]) component.handleInput?.(key);
        component.handleInput?.("\n");
        expect(component.render(80).join("\n")).toContain("subagent explorer · running");
        activeBindings = {
          ...activeBindings,
          "tui.altScreen.pageUp": "alt+pageUp",
          "app.tools.expand": "ctrl+x",
        };
      } finally {
        component.dispose?.();
        expect(activeBindings).toEqual({
          ...originalBindings,
          "tui.altScreen.pageUp": "alt+pageUp",
          "app.tools.expand": "ctrl+x",
        });
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

  it("routes fullscreen PageUp through TuiAltScreen to the focused session panel", async () => {
    // Intent: exercise Pi's real input-listener order, not only the keybinding snapshot passed to the panel.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousKeybindings = getKeybindings();
    const agentDir = await createTempWorkspace();
    const cwd = await createTempWorkspace();
    const terminal = new TestTerminal();
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.altScreen.pageUp": ["pageUp", "ctrl+alt+u"],
      "tui.altScreen.pageDown": ["pageDown", "ctrl+alt+d"],
      "tui.altScreen.halfPageUp": ["ctrl+u", "ctrl+shift+up"],
      "tui.altScreen.halfPageDown": ["ctrl+d", "ctrl+shift+down"],
      "tui.altScreen.top": ["home", "ctrl+home"],
      "tui.altScreen.bottom": ["end", "ctrl+end"],
    });
    const tui = new TuiAltScreen(terminal);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    setKeybindings(keybindings);
    tui.start();
    try {
      await createPersistedSession(cwd, "scroll-child", 12);
      const command = captureCommand();
      const custom = async (factory: OverlayFactory): Promise<void> => {
        const component = renderOverlay(factory, { keybindings, tui });
        tui.showOverlay(component, { width: "100%", maxHeight: "100%" });
        try {
          expect(keybindings.getKeys("tui.altScreen.pageUp")).toEqual([]);
          expect(keybindings.getKeys("tui.altScreen.previousPrompt")).toEqual([]);
          expect(keybindings.getKeys("tui.altScreen.nextPrompt")).toEqual([]);
          const initial = component.render(120).join("\n");
          expect(initial).not.toContain("inspect persisted state 0");

          terminal.sendInput("\x1b[5~");
          expect(component.render(120).join("\n")).not.toBe(initial);

          terminal.sendInput("\x1b[1;5H");
          expect(component.render(120).join("\n")).toContain("inspect persisted state 0");

          terminal.sendInput("\x04");
          expect(component.render(120).join("\n")).not.toContain("inspect persisted state 0");
          terminal.sendInput("\x15");
          expect(component.render(120).join("\n")).toContain("inspect persisted state 0");

          terminal.sendInput("\x1b[1;5F");
          const atBottom = component.render(120).join("\n");
          expect(atBottom).toContain("finished report");

          terminal.sendInput("\x1b[1;6A");
          const afterConflictingHalfPageUp = component.render(120).join("\n");
          expect(afterConflictingHalfPageUp).not.toBe(atBottom);
          terminal.sendInput("\x1b[1;6B");
          expect(component.render(120).join("\n")).toBe(atBottom);
        } finally {
          tui.hideOverlay();
          component.dispose?.();
        }
        expect(keybindings.getKeys("tui.altScreen.pageUp")).toEqual(["pageUp", "ctrl+alt+u"]);
        expect(keybindings.getKeys("tui.altScreen.previousPrompt")).toEqual(["ctrl+shift+up"]);
        expect(keybindings.getKeys("tui.altScreen.nextPrompt")).toEqual(["ctrl+shift+down"]);
      };

      await command.handler("scroll-child", createContext(cwd, custom, []));
    } finally {
      tui.stop();
      setKeybindings(previousKeybindings);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("does not rewrite fullscreen bindings in regular TUI mode", async () => {
    // Intent: the workaround must stay scoped to the renderer that owns the competing viewport listener.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await createTempWorkspace();
    const cwd = await createTempWorkspace();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await createPersistedSession(cwd, "regular-child");
      const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
        "tui.altScreen.pageUp": "ctrl+pageUp",
      });
      const setUserBindings = vi.spyOn(keybindings, "setUserBindings");
      const custom = async (factory: OverlayFactory): Promise<void> => {
        const component = renderOverlay(factory, {
          keybindings,
          tui: { mode: "regular", terminal: { rows: 24 }, requestRender: () => undefined } as never,
        });
        component.dispose?.();
      };

      await captureCommand().handler("regular-child", createContext(cwd, custom, []));
      expect(setUserBindings).not.toHaveBeenCalled();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("restores fullscreen bindings if session panel construction fails", async () => {
    // Intent: constructor-side keybinding changes must not survive a downstream subscription failure.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await createTempWorkspace();
    const cwd = await createTempWorkspace();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const onChange = vi.spyOn(subagentRegistry, "onChange").mockImplementationOnce(() => {
      throw new Error("registry subscription failed");
    });
    try {
      await createPersistedSession(cwd, "broken-child");
      const originalBindings = {
        "tui.altScreen.pageUp": "pageUp",
        "tui.altScreen.pageDown": "pageDown",
      } as const;
      const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, originalBindings);
      const custom = async (factory: OverlayFactory): Promise<void> => {
        expect(() => renderOverlay(factory, { keybindings })).toThrow("registry subscription failed");
        expect(keybindings.getUserBindings()).toEqual(originalBindings);
      };

      await captureCommand().handler("broken-child", createContext(cwd, custom, []));
    } finally {
      onChange.mockRestore();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("restores bindings when an explicit live target disappears before the overlay mounts", async () => {
    // Intent: Pi stores custom components in a promise continuation, so an early close must wait until disposal is wired.
    const cwd = await createTempWorkspace();
    let releasePrompt = (): void => undefined;
    const pendingPrompt = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const source: SubagentViewSource = {
      cwd,
      getMessages: () => [],
      getStreamingMessage: () => undefined,
      getActiveTools: () => [],
      getCompletedTools: () => [],
      getToolDefinition: () => undefined,
      subscribe: () => () => undefined,
    };
    const child: SubagentSession = {
      sessionId: "volatile-child",
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

    const originalBindings = {
      "tui.altScreen.pageUp": "pageUp",
      "tui.altScreen.pageDown": "pageDown",
      "tui.altScreen.top": "home",
      "tui.altScreen.bottom": "end",
    } as const;
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, originalBindings);
    let disposed = false;
    const custom = async (factory: OverlayFactory): Promise<void> => {
      releasePrompt();
      await runPromise;
      await new Promise<void>((resolve, reject) => {
        let mounted: (Component & { dispose?: () => void }) | undefined;
        let closed = false;
        const done = () => {
          if (closed) return;
          closed = true;
          try {
            mounted?.dispose?.();
            disposed = mounted !== undefined;
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        Promise.resolve(renderOverlay(factory, { keybindings, done }))
          .then((component) => {
            if (!closed) mounted = component;
          })
          .catch(reject);
      });
    };
    const notifications: string[] = [];
    try {
      await captureCommand().handler("volatile-child", createContext(cwd, custom, notifications));
    } finally {
      releasePrompt();
      await runPromise;
    }

    expect(disposed).toBe(true);
    expect(keybindings.getUserBindings()).toEqual(originalBindings);
    expect(notifications).toEqual(['Subagent "volatile-child" is no longer available.']);
  });

  it("rejects unsupported contexts and reports empty or missing selections without opening an overlay", async () => {
    // Intent: command validation should remain side-effect free when no view can be opened.
    const command = captureCommand();
    const notifications: string[] = [];
    const custom = vi.fn(async () => undefined);
    const nonInteractive = {
      ...createContext("/tmp/work", custom, notifications),
      hasUI: false,
      mode: "rpc",
    } as never;

    await command.handler("", nonInteractive);
    await command.handler("", createContext("/tmp/work", custom, notifications));
    await command.handler("missing", createContext("/tmp/work", custom, notifications));

    expect(custom).not.toHaveBeenCalled();
    expect(notifications).toEqual([
      "/subagent requires the root interactive UI.",
      "No running subagents are available to view.",
      'Subagent "missing" was not found.',
    ]);
  });

  it("reports ambiguous persisted session prefixes", async () => {
    // Intent: a prefix must identify exactly one persisted session before the overlay is created.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await createTempWorkspace();
    const cwd = await createTempWorkspace();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await createPersistedSession(cwd, "shared-prefix-a");
      await createPersistedSession(cwd, "shared-prefix-b");
      const command = captureCommand();
      const notifications: string[] = [];
      const custom = vi.fn(async () => undefined);

      await command.handler("shared-prefix", createContext(cwd, custom, notifications));

      expect(custom).not.toHaveBeenCalled();
      expect(notifications).toEqual(['Subagent "shared-prefix" is ambiguous.']);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
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
        getCompletedTools: () => [],
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
          expect(output).toContain("subagent explorer · done · actual-provider/actual-model · thinking: max");
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

  it("prevents concurrent viewer overlays and allows reopening after close", async () => {
    // Intent: concurrent command dispatch must not create a second overlay while one is active.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await createTempWorkspace();
    const cwd = await createTempWorkspace();
    let closeViewer = (): void => undefined;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await createPersistedSession(cwd, "completed-child");
      const command = captureCommand();
      const notifications: string[] = [];
      const viewerClosed = new Promise<void>((resolve) => { closeViewer = resolve; });
      const custom = vi.fn(async () => viewerClosed);
      const ctx = createContext(cwd, custom, notifications);

      const firstOpen = command.handler("completed-child", ctx);
      const concurrentOpen = command.handler("completed-child", ctx);
      await concurrentOpen;
      await vi.waitFor(() => expect(custom).toHaveBeenCalledTimes(1));

      expect(custom).toHaveBeenCalledTimes(1);
      expect(notifications).toEqual(["The subagent viewer is already open."]);

      closeViewer();
      await firstOpen;
      await command.handler("completed-child", ctx);
      expect(custom).toHaveBeenCalledTimes(2);
    } finally {
      closeViewer();
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
          expect(output).toContain("subagent explorer · done · actual-provider/actual-model · thinking: max · turns: 1 · tool calls: 0");
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
