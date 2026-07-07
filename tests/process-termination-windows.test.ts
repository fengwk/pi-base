import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: childProcessMock.spawn,
}));

const { createGracefulTerminator } = await import("../src/process-termination.js");

class FakeChild extends EventEmitter {
  pid = 4242;
  killedSignals: string[] = [];

  kill(signal?: NodeJS.Signals) {
    this.killedSignals.push(String(signal));
    return true;
  }
}

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

describe("createGracefulTerminator on Windows", () => {
  it("uses taskkill for process-tree force termination and ignores taskkill spawn errors", async () => {
    // Intent: Windows tree cleanup relies on taskkill; missing taskkill or a
    // spawn error must not crash the extension while cleaning up tool children.
    vi.useFakeTimers();
    try {
      const killer = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
      killer.unref = vi.fn();
      childProcessMock.spawn.mockReturnValueOnce(killer);

      await withPlatform("win32", async () => {
        const child = new FakeChild();
        const terminator = createGracefulTerminator(child as any, { killTree: true, forceKillAfterMs: 25 });

        terminator.terminate();
        expect(child.killedSignals).toEqual(["SIGTERM"]);
        await vi.advanceTimersByTimeAsync(25);

        expect(childProcessMock.spawn).toHaveBeenCalledWith("taskkill", ["/F", "/T", "/PID", "4242"], {
          stdio: "ignore",
          detached: true,
        });
        expect(killer.unref).toHaveBeenCalled();
        expect(killer.listenerCount("error")).toBe(1);
        expect(() => killer.emit("error", new Error("taskkill missing"))).not.toThrow();
      });
    } finally {
      childProcessMock.spawn.mockReset();
      vi.useRealTimers();
    }
  });

  it("falls back to SIGKILL for single-process force termination", async () => {
    // Intent: Windows single-process cleanup should avoid taskkill and use the
    // same direct child kill semantics as other platforms.
    vi.useFakeTimers();
    try {
      await withPlatform("win32", async () => {
        const child = new FakeChild();
        const terminator = createGracefulTerminator(child as any, { forceKillAfterMs: 10 });

        terminator.terminate();
        await vi.advanceTimersByTimeAsync(10);

        expect(child.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(childProcessMock.spawn).not.toHaveBeenCalled();
      });
    } finally {
      childProcessMock.spawn.mockReset();
      vi.useRealTimers();
    }
  });
});
