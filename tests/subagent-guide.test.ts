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
      const injected = await registry.emit("before_agent_start", {
        systemPrompt: "base system prompt",
        systemPromptOptions: { selectedTools: ["task"] },
      }, { cwd: nested });

      expect(injected.systemPrompt).toContain("base system prompt");
      expect(injected.systemPrompt).toContain("## Available task subagents");
      expect(injected.systemPrompt).toContain("`helper` — Run long commands");
      expect(injected.systemPrompt).toContain("`reviewer` — Review diffs");
      expect(injected.systemPrompt).toContain(join(workspace, ".pi", "subagents"));
    });
  });

  it("warns when task is active but no subagents are configured", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      const registry = createToolRegistry({ cwd: workspace });
      piBaseExtension(registry.pi as any);
      const injected = await registry.emit("before_agent_start", {
        systemPrompt: "base system prompt",
        systemPromptOptions: { selectedTools: ["task"] },
      }, { cwd: workspace });

      expect(injected.systemPrompt).toContain("## Available task subagents");
      expect(injected.systemPrompt).toContain("None configured for this workspace.");
      expect(injected.systemPrompt).toContain("do not call `task`");
    });
  });
});
