import { describe, expect, it, vi } from "vitest";
import { registerNotifySupport } from "../src/notify.js";
import { createToolRegistry } from "./helpers.js";

const spawnState = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[]; options: any }>,
  onCalls: [] as string[],
  unrefCalls: 0,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string, args: string[], options: any) => {
    spawnState.calls.push({ command, args, options });
    return {
      on(event: string) {
        spawnState.onCalls.push(event);
      },
      unref() {
        spawnState.unrefCalls += 1;
      },
    };
  }),
}));

describe("notify shell sender", () => {
  it("spawns the package notify script with session and terminal context", async () => {
    // Intent: the default sender is used when callers do not inject a notifier;
    // it must pass stable env vars to scripts/notify.sh without blocking Pi.
    const previousTmux = process.env.TMUX_PANE;
    const previousAlacritty = process.env.ALACRITTY_WINDOW_ID;
    process.env.TMUX_PANE = "%42";
    process.env.ALACRITTY_WINDOW_ID = "window-7";
    spawnState.calls = [];
    spawnState.onCalls = [];
    spawnState.unrefCalls = 0;
    try {
      const registry = createToolRegistry({ hasUI: true });
      const hooks = registerNotifySupport(registry.pi as any, {
        loadSettings: () => ({ settings: { notify: { permissionAsked: true, agentEnd: true } } } as any),
      });
      const ctx: any = {
        hasUI: true,
        cwd: "/tmp/demo-project",
        sessionManager: {
          getSessionId: () => "session-1",
          getSessionName: () => "Demo Session",
          getSessionFile: () => "/tmp/session-1.jsonl",
        },
      };

      await hooks.onPermissionAsked({ ctx });

      expect(spawnState.calls).toHaveLength(1);
      expect(spawnState.calls[0].command).toContain("scripts/notify.sh");
      expect(spawnState.calls[0].args).toEqual([]);
      expect(spawnState.calls[0].options.cwd).toBe("/tmp/demo-project");
      expect(spawnState.calls[0].options.stdio).toBe("ignore");
      expect(spawnState.calls[0].options.env).toMatchObject({
        PI_NOTIFY_KIND: "permission.requested",
        PI_NOTIFY_PROJECT: "demo-project",
        PI_NOTIFY_SESSION_ID: "session-1",
        PI_NOTIFY_SESSION_TITLE: "Demo Session",
        PI_NOTIFY_TMUX_PANE: "%42",
        PI_NOTIFY_ALACRITTY_WINDOW_ID: "window-7",
      });
      expect(spawnState.onCalls).toContain("error");
      expect(spawnState.unrefCalls).toBe(1);
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = previousTmux;
      if (previousAlacritty === undefined) delete process.env.ALACRITTY_WINDOW_ID;
      else process.env.ALACRITTY_WINDOW_ID = previousAlacritty;
    }
  });
});
