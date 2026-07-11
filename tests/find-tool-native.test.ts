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

afterEach(() => {
  fakeToolState.fdPath = "";
  delete process.env.PI_BASE_FAKE_FD_MODE;
  delete process.env.PI_BASE_FAKE_FD_OUTPUT;
  delete process.env.PI_BASE_FAKE_FD_COUNT;
  delete process.env.PI_BASE_FAKE_FD_ROOT;
  delete process.env.PI_BASE_FAKE_FD_ARGS_FILE;
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
    expect(getText(result)).toContain("2 results limit reached");
    expect((result as any).details.resultLimitReached).toBe(2);
    const args = JSON.parse(await readFile(argsFile, "utf8"));
    expect(args).toContain("--full-path");
    expect(args).toContain("**/src/*.ts");
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
    await expect(tool.execute("find-3", { path: ".", pattern: "*" })).rejects.toThrow("synthetic fd failure");
  });

  it("reports fd availability failures before spawning a search process", async () => {
    // Intent: missing fd is an environment/setup problem and should be reported
    // before the agent waits for a search that can never start.
    const root = await createTempWorkspace();
    const tool = createFindToolDefinition(root);

    await expect(tool.execute("find-missing-fd", { path: ".", pattern: "*" })).rejects.toThrow("fd is not available");
  });

  it("keeps partial fd output from non-zero exits", async () => {
    // Intent: fd can emit useful matches before a non-zero exit; callers should
    // not lose those matches when fd also reports diagnostics.
    const root = await createTempWorkspace();
    await installFakeFd(root);
    const tool = createFindToolDefinition(root);

    process.env.PI_BASE_FAKE_FD_MODE = "error";
    process.env.PI_BASE_FAKE_FD_OUTPUT = `${join(root, "src", "partial.ts")}\n`;
    const partial = await tool.execute("find-partial", { path: ".", pattern: "*.ts" });
    expect(getText(partial)).toContain("src/partial.ts");
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
});
