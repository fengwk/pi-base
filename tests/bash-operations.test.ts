import { describe, expect, it } from "vitest";
import { createGracefulBashOperations } from "../src/bash-operations.js";

describe("createGracefulBashOperations", () => {
  it("captures stdout and stderr while returning the shell exit code", async () => {
    // Intent: bash rendering and permission layers depend on this adapter to
    // preserve both output streams from the actual shell process.
    const operations = createGracefulBashOperations({ shellPath: "/bin/sh" });
    const chunks: Buffer[] = [];

    const result = await operations.exec(
      "printf stdout; printf stderr >&2",
      process.cwd(),
      {
        onData: (chunk) => chunks.push(chunk),
        timeout: 2,
        env: { ...process.env, PI_BASE_BASH_OPS_TEST: "1" },
      },
    );

    const output = Buffer.concat(chunks).toString("utf8");
    expect(result.exitCode).toBe(0);
    expect(output).toContain("stdout");
    expect(output).toContain("stderr");
  });

  it("rejects with a timeout marker when the shell exceeds the requested timeout", async () => {
    // Intent: command timeout is user-facing behavior; callers convert this
    // marker into a clear bash tool error.
    const operations = createGracefulBashOperations({ shellPath: "/bin/sh" });

    await expect(operations.exec("sleep 1", process.cwd(), {
      onData: () => undefined,
      timeout: 0.05,
    })).rejects.toThrow("timeout:0.05");
  });

  it("rejects when the caller aborts a running shell command", async () => {
    // Intent: agent cancellation must stop the child process and surface an
    // aborted result instead of waiting for the command to finish naturally.
    const operations = createGracefulBashOperations({ shellPath: "/bin/sh" });
    const controller = new AbortController();
    const pending = operations.exec("sleep 1", process.cwd(), {
      onData: () => undefined,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toThrow("aborted");
  });

  it("does not launch a shell when the caller is already aborted", async () => {
    // Intent: a pre-aborted request must short-circuit before shell resolution or spawn; the
    // missing path makes any accidental setup work observable instead of cancellation.
    const operations = createGracefulBashOperations({ shellPath: "/definitely/missing/pi-base-shell" });
    const controller = new AbortController();
    controller.abort();

    await expect(operations.exec("printf should-not-run", process.cwd(), {
      onData: () => undefined,
      signal: controller.signal,
    })).rejects.toThrow("aborted");
  });
});
