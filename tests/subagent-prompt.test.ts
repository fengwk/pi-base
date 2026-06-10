import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSubagentSystemPrompt } from "../src/task/prompt.js";
import { getSubagentConfig, loadSubagentRegistry } from "../src/task/registry.js";
import { createTempWorkspace } from "./helpers.js";

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

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("subagent prompt builder", () => {
  it("injects skills before the body", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      await writeText(join(workspace, ".pi", "skills", "review-guidelines.md"), "Always verify evidence.");
      await writeText(join(agentDir, "subagents", "reviewer.md"), `---
name: reviewer
description: Review code
tools: read,grep
skills: review-guidelines
model: anthropic/claude-opus-4-1
thinking: high
---
You are the reviewer.
`);

      const registry = loadSubagentRegistry(workspace);
      const reviewer = getSubagentConfig(registry, "reviewer");
      expect(reviewer).toBeDefined();
      const prompt = buildSubagentSystemPrompt(reviewer!, workspace);

      expect(prompt).toContain("<skills>");
      expect(prompt).toContain('<skill name="review-guidelines">');
      expect(prompt).toContain("Always verify evidence.");
      expect(prompt.trim().endsWith("You are the reviewer.")).toBe(true);
    });
  });
  it("preserves multiline and missing skill content", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      await writeText(join(workspace, ".pi", "skills", "multi.md"), "line 1\nline 2");
      await writeText(join(agentDir, "subagents", "helper.md"), `---
name: helper
description: Helper
tools: read
skills:
  - multi
  - missing
---
Helper body
`);

      const registry = loadSubagentRegistry(workspace);
      const prompt = buildSubagentSystemPrompt(getSubagentConfig(registry, "helper")!, workspace);
      expect(prompt).toContain("line 1");
      expect(prompt).toContain("line 2");
      expect(prompt).toContain('(Skill "missing" not found in project or global skill locations)');
    });
  });

  it("returns the body unchanged when no skills are configured", async () => {
    const prompt = buildSubagentSystemPrompt({
      name: "caller",
      description: "Caller",
      tools: ["read"],
      skills: [],
      body: "Caller body",
      filePath: "caller.md",
      source: "project",
    }, process.cwd());
    expect(prompt).toBe("Caller body");
  });
});
