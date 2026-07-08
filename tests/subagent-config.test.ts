import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPiBaseSettings } from "../src/config.js";
import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_TURNS,
  loadSubagentConfig,
  resolveSubagentConfig,
} from "../src/subagent/config.js";
import { createTempWorkspace } from "./helpers.js";

async function writeProjectConfig(root: string, settings: unknown): Promise<void> {
  const dir = join(root, ".pi");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pi-base.json"), JSON.stringify(settings), "utf8");
}

describe("subagent config", () => {
  it("applies defaults when no subagent config is present", async () => {
    // Intent: absence of config must yield the documented safe defaults (2 / 10 / 50),
    // so enabling delegation never depends on explicit numbers.
    const root = await createTempWorkspace();
    await writeProjectConfig(root, {});
    const original = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
    const isolatedGlobal = join(root, "isolated-global-pi-base.json");
    try {
      await writeFile(isolatedGlobal, JSON.stringify({}), "utf8");
      process.env.PI_BASE_GLOBAL_SETTINGS_PATH = isolatedGlobal;
      const resolved = resolveSubagentConfig(loadPiBaseSettings(root));
      expect(resolved).toEqual({ maxDepth: DEFAULT_MAX_DEPTH, maxConcurrency: DEFAULT_MAX_CONCURRENCY, maxTurns: DEFAULT_MAX_TURNS });
    } finally {
      if (original === undefined) delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
      else process.env.PI_BASE_GLOBAL_SETTINGS_PATH = original;
    }
  });

  it("reads explicit project overrides", async () => {
    // Intent: operator-provided limits must win over defaults.
    const root = await createTempWorkspace();
    await writeProjectConfig(root, { subagent: { maxDepth: 4, maxConcurrency: 3, maxTotalConcurrency: 12, idleTimeoutMs: 45000, maxTurns: 6 } });
    expect(loadSubagentConfig(root)).toEqual({ maxDepth: 4, maxConcurrency: 3, maxTotalConcurrency: 12, idleTimeoutMs: 45000, maxTurns: 6 });
  });

  it("fills only the missing field with its default", async () => {
    // Intent: partial config should not reset the other limit to a surprising value.
    const root = await createTempWorkspace();
    await writeProjectConfig(root, { subagent: { maxDepth: 5 } });
    const original = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
    const isolatedGlobal = join(root, "isolated-global-pi-base.json");
    try {
      await writeFile(isolatedGlobal, JSON.stringify({}), "utf8");
      process.env.PI_BASE_GLOBAL_SETTINGS_PATH = isolatedGlobal;
      expect(loadSubagentConfig(root)).toEqual({ maxDepth: 5, maxConcurrency: DEFAULT_MAX_CONCURRENCY, maxTurns: DEFAULT_MAX_TURNS });
    } finally {
      if (original === undefined) delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
      else process.env.PI_BASE_GLOBAL_SETTINGS_PATH = original;
    }
  });

  it("treats idleTimeoutMs=0 as disabled", async () => {
    const root = await createTempWorkspace();
    await writeProjectConfig(root, { subagent: { idleTimeoutMs: 0 } });
    const original = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
    const isolatedGlobal = join(root, "isolated-global-pi-base.json");
    try {
      await writeFile(isolatedGlobal, JSON.stringify({}), "utf8");
      process.env.PI_BASE_GLOBAL_SETTINGS_PATH = isolatedGlobal;
      expect(loadSubagentConfig(root)).toEqual({ maxDepth: DEFAULT_MAX_DEPTH, maxConcurrency: DEFAULT_MAX_CONCURRENCY, maxTurns: DEFAULT_MAX_TURNS });
    } finally {
      if (original === undefined) delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
      else process.env.PI_BASE_GLOBAL_SETTINGS_PATH = original;
    }
  });

  it("rejects non-positive maxDepth at load time", async () => {
    // Intent: an invalid depth would silently disable/allow delegation; fail loudly instead.
    const root = await createTempWorkspace();
    await writeProjectConfig(root, { subagent: { maxDepth: 0 } });
    expect(() => loadPiBaseSettings(root)).toThrowError(/subagent\.maxDepth must be a positive integer/);
  });

  it("rejects non-integer maxConcurrency and maxTotalConcurrency at load time", async () => {
    const root = await createTempWorkspace();
    await writeProjectConfig(root, { subagent: { maxConcurrency: 2.5 } });
    expect(() => loadPiBaseSettings(root)).toThrowError(/subagent\.maxConcurrency must be a positive integer/);

    await writeProjectConfig(root, { subagent: { maxTotalConcurrency: 1.5 } });
    expect(() => loadPiBaseSettings(root)).toThrowError(/subagent\.maxTotalConcurrency must be a positive integer/);
  });

  it("rejects negative idleTimeoutMs and non-positive maxTurns at load time", async () => {
    const root = await createTempWorkspace();
    await writeProjectConfig(root, { subagent: { idleTimeoutMs: -1 } });
    expect(() => loadPiBaseSettings(root)).toThrowError(/subagent\.idleTimeoutMs must be a non-negative integer/);

    await writeProjectConfig(root, { subagent: { maxTurns: 0 } });
    expect(() => loadPiBaseSettings(root)).toThrowError(/subagent\.maxTurns must be a positive integer/);
  });
});
