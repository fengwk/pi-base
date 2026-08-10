import { describe, expect, it, vi } from "vitest";
import { createTimeoutSignal, MAX_TIMEOUT_SECONDS, parseTimeoutSeconds } from "../src/timeout.js";

describe("createTimeoutSignal", () => {
  it("rejects timeout values that overflow Node's timer range", () => {
    // Intent: Node clamps oversized timers to 1ms, so accepting such a value would turn a very
    // large timeout into an immediate timeout.
    expect(parseTimeoutSeconds(MAX_TIMEOUT_SECONDS, "timeout_seconds", 1)).toBe(MAX_TIMEOUT_SECONDS);
    expect(() => parseTimeoutSeconds(MAX_TIMEOUT_SECONDS + 1, "timeout_seconds", 1))
      .toThrow(`timeout_seconds must be <= ${MAX_TIMEOUT_SECONDS}`);
    expect(() => createTimeoutSignal(undefined, MAX_TIMEOUT_SECONDS + 1))
      .toThrow(`timeoutSeconds must be <= ${MAX_TIMEOUT_SECONDS}`);
  });

  it("does not create a timer when the parent signal is already aborted", () => {
    // Intent: callers can pass an already-aborted parent during cancellation;
    // this must not leave a timeout handle behind.
    vi.useFakeTimers();
    try {
      const parent = new AbortController();
      parent.abort(new Error("cancelled"));
      const timeout = createTimeoutSignal(parent.signal, 10);

      expect(timeout.signal.aborted).toBe(true);
      expect(timeout.didTimeout()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(() => timeout.cleanup()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts on timeout and cleanup removes the timer", async () => {
    // Intent: the normal timeout path must still mark didTimeout, while
    // cleanup must release the scheduled handle when the caller finishes early.
    vi.useFakeTimers();
    try {
      const timeout = createTimeoutSignal(undefined, 2);
      expect(timeout.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(2_000);

      expect(timeout.signal.aborted).toBe(true);
      expect(timeout.didTimeout()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      const early = createTimeoutSignal(undefined, 10);
      expect(vi.getTimerCount()).toBe(1);
      early.cleanup();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
