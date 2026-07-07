import { once } from "node:events";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createGracefulTerminator } from "../src/process-termination.js";

describe("createGracefulTerminator", () => {
  it("lets child processes handle SIGTERM before a force kill", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-base-term-"));
    const markerPath = join(root, "marker.txt");
    const command = `MARKER=${JSON.stringify(markerPath)}; trap 'printf term > "$MARKER"; exit 0' TERM; while true; do :; done`;
    const child = spawn("bash", ["-c", command], { stdio: "ignore" });
    const terminator = createGracefulTerminator(child, { forceKillAfterMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    terminator.terminate();
    await once(child, "close");
    terminator.cleanup();

    await expect(readFile(markerPath, "utf8")).resolves.toBe("term");
  });

  it("sends SIGTERM once, force-kills later, and cleanup cancels pending force kill", async () => {
    // Intent: the terminator's idempotence and delayed hard-kill behavior are
    // the safety contract used by grep/find/bash wrappers.
    vi.useFakeTimers();
    try {
      class FakeChild extends EventEmitter {
        pid = 12345;
        killedSignals: string[] = [];
        kill(signal?: NodeJS.Signals) {
          this.killedSignals.push(String(signal));
          return true;
        }
      }
      const child = new FakeChild();
      const terminator = createGracefulTerminator(child as any, { forceKillAfterMs: 50 });

      terminator.terminate();
      terminator.terminate();
      expect(terminator.isTerminating()).toBe(true);
      expect(child.killedSignals).toEqual(["SIGTERM"]);

      await vi.advanceTimersByTimeAsync(49);
      expect(child.killedSignals).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);

      const cleanupChild = new FakeChild();
      const cleanupTerminator = createGracefulTerminator(cleanupChild as any, { forceKillAfterMs: 50 });
      cleanupTerminator.terminate();
      cleanupTerminator.cleanup();
      await vi.advanceTimersByTimeAsync(100);
      expect(cleanupChild.killedSignals).toEqual(["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not signal a child that already exited", () => {
    // Intent: late cancellation after process exit must be a no-op and must not
    // resurrect a force-kill timer.
    vi.useFakeTimers();
    try {
      class FakeChild extends EventEmitter {
        killedSignals: string[] = [];
        kill(signal?: NodeJS.Signals) {
          this.killedSignals.push(String(signal));
          return true;
        }
      }
      const child = new FakeChild();
      const terminator = createGracefulTerminator(child as any, { forceKillAfterMs: 50 });
      child.emit("exit", 0);

      terminator.terminate();

      expect(child.killedSignals).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
