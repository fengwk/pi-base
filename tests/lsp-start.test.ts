import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LspClient } from "../src/lsp/client.js";
import { createTempWorkspace } from "./helpers.js";

async function createFakeServer(root: string, name: string, argsFile: string): Promise<string> {
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const serverPath = join(binDir, name);
  await writeFile(
    serverPath,
    `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
sleep 60
`,
    { mode: 0o755 },
  );
  return serverPath;
}

async function startAndStop(client: LspClient): Promise<void> {
  await client.start();
  await client.stop();
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}

describe("LspClient start command enhancement", () => {
  it("injects process-scoped jdtls workspace data when no explicit -data is present", async () => {
    // Intent: this verifies the real spawned command receives the generated
    // workspace data path that prevents concurrent jdtls lock conflicts.
    const root = await createTempWorkspace();
    const argsFile = join(root, "jdtls-args.txt");
    const fakeJdtls = await createFakeServer(root, "jdtls", argsFile);
    const client = new LspClient(root, {
      id: "jdtls",
      command: [fakeJdtls],
      extensions: [".java"],
      requestTimeoutMs: 20,
      workspaceData: { mode: "process", baseDir: join(root, "jdtls-data") },
    });

    await startAndStop(client);

    const args = (await readFile(argsFile, "utf8")).trim().split("\n");
    const dataIndex = args.indexOf("-data");
    expect(dataIndex).toBeGreaterThanOrEqual(0);
    expect(args[dataIndex + 1]).toMatch(new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/jdtls-data/[a-f0-9]{32}-${process.pid}$`));
    expect(args.some((arg) => arg.startsWith("--jvm-arg=-Xmx"))).toBe(true);
  });

  it("does not override explicit jdtls -data arguments", async () => {
    // Intent: users may own jdtls workspace selection in their command; pi-base
    // must not append a second conflicting -data.
    const root = await createTempWorkspace();
    const argsFile = join(root, "jdtls-explicit-args.txt");
    const fakeJdtls = await createFakeServer(root, "jdtls", argsFile);
    const explicitData = join(root, "custom-data");
    const client = new LspClient(root, {
      id: "jdtls",
      command: [fakeJdtls, "-data", explicitData],
      extensions: [".java"],
      requestTimeoutMs: 20,
      workspaceData: { mode: "process", baseDir: join(root, "ignored") },
    });

    await startAndStop(client);

    const args = (await readFile(argsFile, "utf8")).trim().split("\n");
    expect(args.filter((arg) => arg === "-data")).toHaveLength(1);
    expect(args[args.indexOf("-data") + 1]).toBe(explicitData);
  });

  it("can disable automatic jdtls -data injection", async () => {
    // Intent: disabled mode is for custom launchers that handle workspace data
    // themselves; no implicit -data should be present.
    const root = await createTempWorkspace();
    const argsFile = join(root, "jdtls-disabled-args.txt");
    const fakeJdtls = await createFakeServer(root, "jdtls", argsFile);
    const client = new LspClient(root, {
      id: "jdtls",
      command: [fakeJdtls],
      extensions: [".java"],
      requestTimeoutMs: 20,
      workspaceData: { mode: "disabled" },
    });

    await startAndStop(client);

    const args = (await readFile(argsFile, "utf8")).trim().split("\n").filter(Boolean);
    expect(args).not.toContain("-data");
  });

  it.skipIf(process.platform === "win32")("force-terminates a server that ignores SIGTERM", async () => {
    // Intent: stop/reload must not return while an unresponsive LSP process remains alive; the
    // bounded protocol shutdown is followed by an actual non-ignorable termination on POSIX.
    const root = await createTempWorkspace();
    const serverPath = join(root, "ignore-term-lsp");
    await writeFile(
      serverPath,
      `#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );
    const client = new LspClient(root, {
      id: "ignore-term",
      command: [serverPath],
      extensions: [".txt"],
      requestTimeoutMs: 20,
    });
    await client.start();
    const pid = (client as any).proc.pid as number;

    try {
      await client.stop({ shutdownGraceMs: 20 });
      await waitForProcessExit(pid, 500);
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      if (isProcessAlive(pid)) {
        process.kill(pid, "SIGKILL");
        await waitForProcessExit(pid, 500);
      }
    }
  });

  it("throws a clear startup error for a missing LSP executable", async () => {
    // Intent: missing LSP binaries are a common setup problem; start() should
    // fail fast with an actionable command string.
    const root = await createTempWorkspace();
    const client = new LspClient(root, {
      id: "missing",
      command: [join(root, "bin", "definitely-missing-lsp")],
      extensions: [".missing"],
      requestTimeoutMs: 20,
    });

    await expect(client.start()).rejects.toThrow(/definitely-missing-lsp/);
  });
});
