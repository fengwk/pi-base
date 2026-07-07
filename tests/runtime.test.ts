import { describe, expect, it } from "vitest";
import { throwIfAborted, throwIfAbortedAfter } from "../src/runtime.js";

describe("runtime abort helpers", () => {
  it("throws only when the signal is already aborted", () => {
    // Intent: throwIfAborted is the cancellation gate used across the file tools;
    // it must be a no-op without a signal and raise once the signal is aborted.
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();

    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(/Operation aborted/);
  });

  it("returns the resolved value unless the signal aborts before completion", async () => {
    // Intent: throwIfAbortedAfter must pass through async results, but convert a
    // cancellation that lands during the await into an aborted error.
    await expect(throwIfAbortedAfter(Promise.resolve("done"))).resolves.toBe("done");

    const controller = new AbortController();
    const pending = throwIfAbortedAfter(
      new Promise<string>((resolve) => setTimeout(() => resolve("late"), 5)),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/Operation aborted/);
  });
});
