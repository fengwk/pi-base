import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFindToolDefinition } from "../src/find-tool.js";
import { createTempWorkspace, getText } from "./helpers.js";

const fakeToolState = vi.hoisted(() => ({ fdPath: "" }));

vi.mock("../src/internal/pi-coding-agent-utils.js", () => ({
  ensureTool: vi.fn(async (tool: string) => {
    if (tool !== "fd" || !fakeToolState.fdPath) return undefined;
    return fakeToolState.fdPath;
  }),
}));

// Resolve the real system fd (PATH lookup, no hardcoded home) so limit
// normalization can be exercised against the actual fd --max-results semantics.
const { getToolPath: getRealToolPath } = await vi.importActual<typeof import("../src/internal/pi-coding-agent-utils.js")>(
  "../src/internal/pi-coding-agent-utils.js",
);
const realFdPath = getRealToolPath("fd");

afterEach(() => {
  fakeToolState.fdPath = "";
  delete process.env.PI_BASE_FAKE_FD_MODE;
  delete process.env.PI_BASE_FAKE_FD_OUTPUT;
  delete process.env.PI_BASE_FAKE_FD_COUNT;
  delete process.env.PI_BASE_FAKE_FD_ROOT;
  delete process.env.PI_BASE_FAKE_FD_ARGS_FILE;
  delete process.env.PI_BASE_FAKE_FD_PID_FILE;
});

async function installFakeFd(root: string): Promise<string> {
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const fdPath = join(binDir, "fd");
  await writeFile(
    fdPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  console.log("fd 99.0.0");
  process.exit(0);
}
if (process.env.PI_BASE_FAKE_FD_ARGS_FILE) {
  fs.writeFileSync(process.env.PI_BASE_FAKE_FD_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
}
const mode = process.env.PI_BASE_FAKE_FD_MODE || "match";
if (mode === "wait") {
  setInterval(() => {}, 1000);
} else if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
  fs.writeFileSync(process.env.PI_BASE_FAKE_FD_PID_FILE, String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === "error") {
  const output = process.env.PI_BASE_FAKE_FD_OUTPUT || "";
  if (output) process.stdout.write(output);
  console.error("synthetic fd failure");
  process.exit(2);
} else {
  const count = Number(process.env.PI_BASE_FAKE_FD_COUNT || "0");
  if (count > 0) {
    const root = process.env.PI_BASE_FAKE_FD_ROOT || process.cwd();
    const lines = [];
    for (let i = 0; i < count; i++) {
      lines.push(root + "/src/very-long-file-name-" + String(i).padStart(4, "0") + "-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.ts");
    }
    process.stdout.write(lines.join("\\n") + "\\n");
  } else {
    const output = process.env.PI_BASE_FAKE_FD_OUTPUT || "";
    if (output) process.stdout.write(output);
  }
}
`,
    { mode: 0o755 },
  );
  fakeToolState.fdPath = fdPath;
  return fdPath;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}

async function waitForPidFile(pidFile: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return Number(await readFile(pidFile, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`pid file was not written within ${timeoutMs}ms`);
}

describe("createFindToolDefinition native fd path", () => {
  it("uses full-path matching for slash patterns and relativizes fd output", async () => {
    // Intent: pi-base wraps fd to require an explicit search path and to return
    // workspace-relative, POSIX-style results that are safe to feed into read.
    const root = await createTempWorkspace();
    await installFakeFd(root);
    const argsFile = join(root, "fd-args.json");
    process.env.PI_BASE_FAKE_FD_ARGS_FILE = argsFile;
    process.env.PI_BASE_FAKE_FD_OUTPUT = [
      join(root, "pkg", "src", "alpha.ts"),
      `${join(root, "pkg", "src", "nested")}\/`,
      "",
    ].join("\n");

    const tool = createFindToolDefinition(root);
    const result = await tool.execute("find-1", { path: "pkg", pattern: "src/*.ts", limit: 2 });

    expect(getText(result)).toContain("src/alpha.ts");
    expect(getText(result)).toContain("src/nested/");
    expect(getText(result)).not.toContain("results limit reached");
    expect((result as any).details?.resultLimitReached).toBeUndefined();
    const args = JSON.parse(await readFile(argsFile, "utf8"));
    expect(args).toContain("--full-path");
    expect(args).toContain("**/src/*.ts");
    // fd must never receive 0 (treated as unlimited) and must be asked for one
    // result beyond the limit so "exactly N" is distinguishable from "more than N".
    expect(args).not.toContain("0");
    expect(args.indexOf("--max-results")).toBeGreaterThanOrEqual(0);
    expect(args[args.indexOf("--max-results") + 1]).toBe("3");
  });

  it("never passes 0 to fd and floors positive decimal limits", async () => {
    // Intent: fd treats --max-results 0 as unlimited and rejects negative or
    // fractional counts, so the local layer must normalize before spawning:
    // 0 and negatives clamp to 1, positive decimals floor to an integer.
    const root = await createTempWorkspace();
    await installFakeFd(root);
    const argsFile = join(root, "fd-args.json");
    process.env.PI_BASE_FAKE_FD_ARGS_FILE = argsFile;
    process.env.PI_BASE_FAKE_FD_COUNT = "5";
    const tool = createFindToolDefinition(root);

    const zero = await tool.execute("find-zero", { path: ".", pattern: "*", limit: 0 });
    const zeroArgs = JSON.parse(await readFile(argsFile, "utf8"));
    // limit 0 clamps to 1, and fd is probed for limit+1 = 2.
    expect(zeroArgs[zeroArgs.indexOf("--max-results") + 1]).toBe("2");
    expect(getText(zero).split("\n\n[")[0].split("\n").filter(Boolean)).toHaveLength(1);
    expect(getText(zero)).toContain("1 results limit reached");

    const negative = await tool.execute("find-negative", { path: ".", pattern: "*", limit: -5 });
    const negativeArgs = JSON.parse(await readFile(argsFile, "utf8"));
    expect(negativeArgs[negativeArgs.indexOf("--max-results") + 1]).toBe("2");
    expect(getText(negative).split("\n\n[")[0].split("\n").filter(Boolean)).toHaveLength(1);

    const decimal = await tool.execute("find-decimal", { path: ".", pattern: "*", limit: 2.9 });
    const decimalArgs = JSON.parse(await readFile(argsFile, "utf8"));
    // 2.9 floors to 2 without losing ordinary positive integers, probe 3.
    expect(decimalArgs[decimalArgs.indexOf("--max-results") + 1]).toBe("3");
    expect(getText(decimal).split("\n\n[")[0].split("\n").filter(Boolean)).toHaveLength(2);
    expect(getText(decimal)).toContain("2 results limit reached");
  });

  it("emits the limit hint only for real overflow and caps output at the limit", async () => {
    // Intent: exactly N matches must not claim truncation (the old >= comparison
    // produced a false hint), while more than N matches must be detected via the
    // limit+1 probe, cut back to N entries and reported.
    const root = await createTempWorkspace();
    await installFakeFd(root);
    const tool = createFindToolDefinition(root);

    process.env.PI_BASE_FAKE_FD_COUNT = "2";
    const exact = await tool.execute("find-exact", { path: ".", pattern: "*", limit: 2 });
    expect(getText(exact).split("\n\n[")).toHaveLength(1);
    expect((exact as any).details?.resultLimitReached).toBeUndefined();

    process.env.PI_BASE_FAKE_FD_COUNT = "5";
    const overflow = await tool.execute("find-overflow", { path: ".", pattern: "*", limit: 2 });
    const overflowBody = getText(overflow).split("\n\n[")[0];
    expect(overflowBody.split("\n").filter(Boolean)).toHaveLength(2);
    expect(getText(overflow)).toContain("2 results limit reached");
    expect((overflow as any).details.resultLimitReached).toBe(2);
  });

  it.skipIf(!realFdPath)("normalizes limits against real fd output", async () => {
    // Intent: the regression must hold for the real fd binary, whose --max-results 0
    // means unlimited and whose negative/fractional counts are argument errors. fd is
    // resolved through PATH (agent bin dir); the case is skipped when fd is absent.
    const root = await createTempWorkspace();
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      await writeFile(join(root, name), "");
    }
    fakeToolState.fdPath = realFdPath ?? "";
    const tool = createFindToolDefinition(root);

    // Exactly N matches with limit N: no truncation notice.
    const exact = await tool.execute("find-real-exact", { path: ".", pattern: "*", limit: 3 });
    expect(getText(exact).split("\n").filter(Boolean)).toHaveLength(3);
    expect(getText(exact)).not.toContain("results limit reached");
    expect((exact as any).details?.resultLimitReached).toBeUndefined();

    // More than N matches with limit N: N lines plus an explicit overflow notice.
    const overflow = await tool.execute("find-real-overflow", { path: ".", pattern: "*", limit: 2 });
    const overflowBody = getText(overflow).split("\n\n[")[0];
    expect(overflowBody.split("\n").filter(Boolean)).toHaveLength(2);
    expect(getText(overflow)).toContain("2 results limit reached");
    expect((overflow as any).details.resultLimitReached).toBe(2);

    // 0 and negative limits clamp to 1 (fd's 0 would otherwise mean unlimited).
    const zero = await tool.execute("find-real-zero", { path: ".", pattern: "*", limit: 0 });
    expect(getText(zero).split("\n\n[")[0].split("\n").filter(Boolean)).toHaveLength(1);
    expect(getText(zero)).toContain("1 results limit reached");

    const negative = await tool.execute("find-real-negative", { path: ".", pattern: "*", limit: -5 });
    expect(getText(negative).split("\n\n[")[0].split("\n").filter(Boolean)).toHaveLength(1);
    expect(getText(negative)).toContain("1 results limit reached");
  });

  it("preserves trailing spaces in matched file names", async () => {
    // Intent: fd output is a path protocol; trimming a result changes the
    // target and can make the returned path refer to a nonexistent file.
    const root = await createTempWorkspace();
    await installFakeFd(root);
    process.env.PI_BASE_FAKE_FD_OUTPUT = `${join(root, "trailing ")}\n`;

    const result = await createFindToolDefinition(root).execute("find-spaced", { path: ".", pattern: "*" });

    expect(getText(result)).toBe("trailing ");
  });

  it("distinguishes empty results from fd execution failures", async () => {
    // Intent: no matches are normal model feedback; fd failures should remain
    // errors with stderr details.
    const root = await createTempWorkspace();
    await installFakeFd(root);
    const tool = createFindToolDefinition(root);

    process.env.PI_BASE_FAKE_FD_OUTPUT = "";
    const empty = await tool.execute("find-2", { path: ".", pattern: "*.missing" });
    expect(getText(empty)).toBe("No files found matching pattern");

    process.env.PI_BASE_FAKE_FD_MODE = "error";
    const failed = await tool.execute("find-3", { path: ".", pattern: "*" });
    expect(failed.isError).toBe(true);
    expect(getText(failed)).toContain("fd exited with code 2");
    expect(getText(failed)).toContain("stderr: synthetic fd failure");
  });

  it("reports fd availability failures before spawning a search process", async () => {
    // Intent: missing fd is an environment/setup problem and should be reported before spawn,
    // while the pre-spawn cancellation listener must still be released with the failed call.
    const root = await createTempWorkspace();
    const tool = createFindToolDefinition(root);
    const controller = new AbortController();

    await expect(tool.execute("find-missing-fd", { path: ".", pattern: "*" }, controller.signal)).rejects.toThrow("fd is not available");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("keeps partial fd output from non-zero exits", async () => {
    // Intent: fd can emit useful matches before a non-zero exit, but preserved
    // stdout must remain explicitly partial and must never turn failure into success.
    const root = await createTempWorkspace();
    await installFakeFd(root);
    const tool = createFindToolDefinition(root);

    process.env.PI_BASE_FAKE_FD_MODE = "error";
    process.env.PI_BASE_FAKE_FD_OUTPUT = `${join(root, "src", "partial.ts")}\n`;
    const partial = await tool.execute("find-partial", { path: ".", pattern: "*.ts" });
    expect(partial.isError).toBe(true);
    expect(getText(partial)).toContain("Error: fd exited with code 2.");
    expect(getText(partial)).toContain("stderr: synthetic fd failure");
    expect(getText(partial)).toContain("Partial output:\nsrc/partial.ts");
    expect((partial as any).details).toMatchObject({ exitCode: 2, partialOutput: true });
  });

  it("leaves byte truncation to the shared tool-output layer", async () => {
    // Intent: native find must return all result-limited paths so the shared output policy can
    // save the complete list before presenting a smaller preview.
    const root = await createTempWorkspace();
    await installFakeFd(root);
    process.env.PI_BASE_FAKE_FD_ROOT = root;
    process.env.PI_BASE_FAKE_FD_COUNT = "1000";
    const tool = createFindToolDefinition(root);

    const result = await tool.execute("find-large", { path: ".", pattern: "*", limit: 1000 });

    expect(getText(result).length).toBeGreaterThan(50 * 1024);
    expect((result as any).details?.truncation).toBeUndefined();
  });

  it("aborts before and during fd execution", async () => {
    // Intent: cancellation must reject promptly both before fd is launched and
    // while a long-running fd process is active.
    const root = await createTempWorkspace();
    await installFakeFd(root);
    const tool = createFindToolDefinition(root);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(tool.execute("find-4", { path: ".", pattern: "*" }, alreadyAborted.signal)).rejects.toThrow("Operation aborted");

    process.env.PI_BASE_FAKE_FD_MODE = "wait";
    const inFlight = new AbortController();
    const pending = tool.execute("find-5", { path: ".", pattern: "*" }, inFlight.signal);
    await new Promise((resolve) => setTimeout(resolve, 25));
    inFlight.abort();
    await expect(pending).rejects.toThrow("Operation aborted");
  });

  it("keeps the default force-kill watchdog after cancellation rejects", async () => {
    // Intent: callers should receive prompt cancellation while an fd that ignores SIGTERM is
    // still guaranteed to die when the shared default SIGKILL window expires.
    const root = await createTempWorkspace();
    await installFakeFd(root);
    const pidFile = join(root, "fd.pid");
    process.env.PI_BASE_FAKE_FD_MODE = "ignore-term";
    process.env.PI_BASE_FAKE_FD_PID_FILE = pidFile;
    const controller = new AbortController();
    const pending = createFindToolDefinition(root).execute("find-force-kill", { path: ".", pattern: "*" }, controller.signal);
    let pid: number | undefined;

    try {
      pid = await waitForPidFile(pidFile, 2_000);
      const abortedAt = Date.now();
      controller.abort();
      await expect(pending).rejects.toThrow("Operation aborted");
      expect(Date.now() - abortedAt).toBeLessThan(1_000);

      await waitForProcessExit(pid, 5_000);
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      controller.abort();
      if (pid !== undefined && isProcessAlive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 8_000);
});
