import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForChildProcess } from "../src/internal/pi-coding-agent-utils.js";

/**
 * Deterministic regression for `waitForChildProcess`'s post-exit drain window.
 *
 * Fake timers drive the 100ms grace window without depending on machine speed,
 * and PassThrough streams stand in for the child's stdio pipes so chunk timing
 * is fully controlled by the test.
 */
type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough };

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  // The helper destroys the streams once the wait settles; noop error handlers
  // keep deliberately damaged scenarios from crashing via an uncaught 'error'.
  child.stdout.on("error", () => undefined);
  child.stderr.on("error", () => undefined);
  return child;
}

// Flush stream-internal nextTick scheduling plus the promise callbacks the
// helper resolves; only setTimeout/clearTimeout are faked, so setImmediate is real.
const drain = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

describe("waitForChildProcess", () => {
  beforeEach(() => {
    // Fake only the helper's grace timer; stream internals must keep using the
    // real nextTick/setImmediate to behave like production pipes.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps draining active descendant output after exit instead of cutting the tail at 100ms", async () => {
    // Intent: reproduces the bash tail loss (earendil-works/pi#5303) — a shell
    // exits while a detached descendant keeps writing to the inherited pipe.
    // The old helper destroyed the streams on a deadline measured once from
    // 'exit', silently dropping every later chunk; each post-exit chunk must
    // instead re-arm the idle window, on both streams, and resolution must
    // still occur exactly one quiet window after the final chunk.
    const child = createFakeChild();
    const received: string[] = [];
    child.stdout.on("data", (chunk) => received.push(chunk.toString()));
    child.stderr.on("data", (chunk) => received.push(chunk.toString()));

    let exitCode: number | null | undefined;
    const pending = waitForChildProcess(child as unknown as ChildProcess).then((code) => {
      exitCode = code;
    });

    child.stdout.write("CHUNK-0\n");
    await drain();
    child.emit("exit", 0); // shell is gone; the descendant still holds the pipe
    await drain();

    // 16 chunks at 25ms intervals on alternating streams: the old fixed
    // deadline (exit + 100ms) expires mid-stream and loses the tail.
    for (let i = 1; i <= 16; i++) {
      vi.advanceTimersByTime(25);
      await drain();
      (i % 2 === 0 ? child.stdout : child.stderr).write(`CHUNK-${i}\n`);
      await drain();
      // Still draining: no output chunk may finalize the wait.
      expect(exitCode).toBeUndefined();
      // Re-arming replaces the pending timer instead of stacking timers.
      expect(vi.getTimerCount()).toBe(1);
    }

    expect(received.join("")).toBe(
      Array.from({ length: 17 }, (_, i) => `CHUNK-${i}\n`).join(""),
    );

    // A quiet window after the last chunk must still be bounded by the budget.
    vi.advanceTimersByTime(99);
    await drain();
    expect(exitCode).toBeUndefined();
    vi.advanceTimersByTime(1);
    await drain();
    await pending;
    expect(exitCode).toBe(0);

    // Only the helper's listeners and timer are torn down; the test collector stays.
    expect(child.stdout.listenerCount("data")).toBe(1);
    expect(child.stderr.listenerCount("data")).toBe(1);
    expect(child.stdout.listenerCount("end")).toBe(0);
    expect(child.stderr.listenerCount("end")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still releases a quiet inherited handle within the original grace budget", async () => {
    // Intent: the idle reset must not reintroduce the hang the helper guards
    // against — with no post-exit output the wait resolves at the same 100ms
    // budget and cleans up exactly as before.
    const child = createFakeChild();
    let exitCode: number | null | undefined;
    const pending = waitForChildProcess(child as unknown as ChildProcess).then((code) => {
      exitCode = code;
    });

    child.emit("exit", 7);
    await drain();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(99);
    await drain();
    expect(exitCode).toBeUndefined();

    vi.advanceTimersByTime(1);
    await drain();
    await pending;
    expect(exitCode).toBe(7);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("finalizes immediately when both streams end normally after exit", async () => {
    // Intent: the common path — stdio really ends after the shell exits — must
    // still resolve right away instead of waiting for the grace timer.
    const child = createFakeChild();
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", () => undefined);
    let exitCode: number | null | undefined;
    const pending = waitForChildProcess(child as unknown as ChildProcess).then((code) => {
      exitCode = code;
    });

    child.emit("exit", 0);
    child.stdout.end();
    child.stderr.end();
    await drain();

    await pending;
    expect(exitCode).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });
});
