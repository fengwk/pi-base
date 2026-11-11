import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGracefulBashOperations } from "../src/bash-operations.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: spawnMock,
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  getShellConfig: () => ({ shell: "mock-shell", args: ["-c"] }),
}));

const drain = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

describe.skipIf(process.platform === "win32")("bash post-exit cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    spawnMock.mockReset();
  });

  it.each(["abort", "timeout"])("honors %s even if descendants keep writing after shell exit", async (mode) => {
    // The leader is gone before cancellation, and the descendant ignores TERM.
    // Continued output must not re-arm the drain timer forever; the pending
    // operation must reject within 100ms while group escalation stays armed.
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    spawnMock.mockReturnValue(child);
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    const controller = new AbortController();
    let outcome: string | undefined;
    const pending = createGracefulBashOperations().exec("mock-command", process.cwd(), {
      onData: () => undefined,
      signal: controller.signal,
      ...(mode === "timeout" ? { timeout: 0.15 } : {}),
    }).then(() => { outcome = "resolved"; }, (error: Error) => { outcome = error.message; });
    child.emit("exit", 0);
    try {
      for (let i = 1; i <= 10; i++) {
        vi.advanceTimersByTime(25);
        await drain();
        if (i === 6 && mode === "abort") controller.abort();
        if (!child.stdout.destroyed) child.stdout.write("tick\n");
        await drain();
      }
      expect(outcome).toBe(mode === "abort" ? "aborted" : "timeout:0.15");
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(-child.pid, "SIGTERM");
      expect(vi.getTimerCount()).toBe(1); // still-live group retains its SIGKILL timer
    } finally {
      child.emit("close", 0);
      await pending;
    }
  });
});
