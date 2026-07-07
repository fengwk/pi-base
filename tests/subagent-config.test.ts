import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPiBaseSettings } from "../src/config.js";
import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_DEPTH,
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
    // Intent: absence of config must yield the documented safe defaults (2 / 10),
    // so enabling delegation never depends on explicit numbers.
    const root = await createTempWorkspace();
    const resolved = resolveSubagentConfig(loadPiBaseSettings(root));
    expect(resolved).toEqual({ maxDepth: DEFAULT_MAX_DEPTH, maxConcurrency: DEFAULT_MAX_CONCURRENCY });
  });

  it("reads explicit project overrides", async () => {
    // Intent: operator-provided limits must win over defaults.
    const root = await createTempWorkspace();
    await writeProjectConfig(root, { subagent: { maxDepth: 4, maxConcurrency: 3 } });
    expect(loadSubagentConfig(root)).toEqual({ maxDepth: 4, maxConcurrency: 3 });
  });

  it("fills only the missing field with its default", async () => {
    // Intent: partial config should not reset the other limit to a surprising value.
    const root = await createTempWorkspace();
    await writeProjectConfig(root, { subagent: { maxDepth: 5 } });
    expect(loadSubagentConfig(root)).toEqual({ maxDepth: 5, maxConcurrency: DEFAULT_MAX_CONCURRENCY });
  });

  it("rejects non-positive maxDepth at load time", async () => {
    // Intent: an invalid depth would silently disable/allow delegation; fail loudly instead.
    const root = await createTempWorkspace();
    await writeProjectConfig(root, { subagent: { maxDepth: 0 } });
    expect(() => loadPiBaseSettings(root)).toThrowError(/subagent\.maxDepth must be a positive integer/);
  });

  it("rejects non-integer maxConcurrency at load time", async () => {
    const root = await createTempWorkspace();
    await writeProjectConfig(root, { subagent: { maxConcurrency: 2.5 } });
    expect(() => loadPiBaseSettings(root)).toThrowError(/subagent\.maxConcurrency must be a positive integer/);
  });
});
