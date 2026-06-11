import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { createTempWorkspace, createToolRegistry } from "./helpers.js";

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await createTempWorkspace();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

async function writeAgentFile(dir: string, name: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), content, "utf8");
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("subagent guide injection", () => {
  it("injects configured subagents into the startup prompt", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      const nested = join(workspace, "packages", "app");
      await mkdir(nested, { recursive: true });
      await writeAgentFile(join(workspace, ".pi", "subagents"), "helper", `---
name: helper
description: Run long commands
tools: bash
skills: []
---
Helper body
`);
      await writeAgentFile(join(workspace, ".pi", "subagents"), "reviewer", `---
name: reviewer
description: Review diffs
tools: read,grep
skills: []
---
Reviewer body
`);

      const registry = createToolRegistry({ cwd: nested });
      piBaseExtension(registry.pi as any);
      await registry.emit("session_start", { reason: "startup" }, { cwd: nested });
      const injected = await registry.emit("before_agent_start", {
        systemPrompt: "base system prompt",
        systemPromptOptions: { selectedTools: registry.getActiveTools() },
      }, { cwd: nested });

      expect(registry.getActiveTools()).toContain("task");
      expect(injected.systemPrompt).toContain("base system prompt");
      expect(injected.systemPrompt).toContain("<available_subagents>");
      expect(injected.systemPrompt).toContain("<name>helper</name>");
      expect(injected.systemPrompt).toContain("<description>Run long commands</description>");
      expect(injected.systemPrompt).toContain("<name>reviewer</name>");
      expect(injected.systemPrompt).not.toContain("<subagent_discovery>");
    });
  });

  it("does not activate or inject task when no subagents are configured", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      const registry = createToolRegistry({ cwd: workspace });
      piBaseExtension(registry.pi as any);
      await registry.emit("session_start", { reason: "startup" }, { cwd: workspace });
      const injected = await registry.emit("before_agent_start", {
        systemPrompt: "base system prompt",
        systemPromptOptions: { selectedTools: registry.getActiveTools() },
      }, { cwd: workspace });

      expect(registry.getActiveTools()).not.toContain("task");
      expect(injected.systemPrompt).not.toContain("<available_subagents>");
    });
  });

  it("removes task from the active tools when subagent discovery fails", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(join(agentDir, "subagents"), "coder", `---
name: coder
description: Broken coder
tools: read
skills: []
model: MiniMax-M2.7
---
Coder body
`);

      const registry = createToolRegistry({ cwd: workspace });
      registry.pi.setActiveTools(["read", "task"]);
      piBaseExtension(registry.pi as any);
      await registry.emit("session_start", { reason: "startup" }, { cwd: workspace });
      const injected = await registry.emit("before_agent_start", {
        systemPrompt: "base system prompt",
        systemPromptOptions: { selectedTools: registry.getActiveTools() },
      }, { cwd: workspace });

      expect(registry.getActiveTools()).toEqual(["read"]);
      expect(injected.systemPrompt).not.toContain("<available_subagents>");
    });
  });
});
