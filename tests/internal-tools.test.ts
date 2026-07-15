import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTempWorkspace } from "./helpers.js";

describe("managed fd/rg installation", () => {
  it("does not treat invalid managed-tool paths as installed executables", async () => {
    // Intent: stale or corrupted paths must not short-circuit installation merely because they
    // exist; callers need a non-empty executable file, not a directory or non-executable residue.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousPath = process.env.PATH;
    const previousOffline = process.env.PI_OFFLINE;
    const agentDir = await createTempWorkspace();
    const managedPath = join(agentDir, "bin", process.platform === "win32" ? "rg.exe" : "rg");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PATH = "";
    process.env.PI_OFFLINE = "1";
    await mkdir(join(agentDir, "bin"), { recursive: true });
    await writeFile(managedPath, "not executable", { mode: 0o644 });
    vi.resetModules();

    try {
      const { ensureTool, getToolPath } = await import("../src/internal/pi-coding-agent-utils.js");
      if (process.platform !== "win32") expect(getToolPath("rg")).toBeNull();
      await rm(managedPath, { force: true });
      await mkdir(managedPath);
      expect(getToolPath("rg")).toBeNull();
      await expect(ensureTool("rg", true)).resolves.toBeUndefined();
    } finally {
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }
  });

  it("shares one in-flight installation and clears it after failure", async () => {
    // Intent: parallel first-use tool calls must not download/extract the same binary twice, while
    // a failed attempt must still allow a later retry.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousPath = process.env.PATH;
    process.env.PI_CODING_AGENT_DIR = await createTempWorkspace();
    process.env.PATH = "";
    vi.resetModules();

    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await fetchGate;
      return new Response("failed", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { ensureTool } = await import("../src/internal/pi-coding-agent-utils.js");
      const first = ensureTool("rg", true);
      const second = ensureTool("rg", true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      releaseFetch();
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      await expect(ensureTool("rg", true)).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("removes partial archives when a managed-tool download stream fails", async () => {
    // Intent: interrupted downloads must not leave a shared archive behind; stale bytes both leak
    // disk space and can collide with another process installing the same tool.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousPath = process.env.PATH;
    const agentDir = await createTempWorkspace();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PATH = "";
    vi.resetModules();

    const brokenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.error(new Error("download interrupted"));
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tag_name: "14.1.1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(brokenBody, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { ensureTool } = await import("../src/internal/pi-coding-agent-utils.js");
      await expect(ensureTool("rg", true)).resolves.toBeUndefined();

      expect(await readdir(join(agentDir, "bin"))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
