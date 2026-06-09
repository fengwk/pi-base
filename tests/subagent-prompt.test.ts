import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSubagentSystemPrompt } from "../src/subagent/prompt.js";
import { loadSubagentRegistry } from "../src/subagent/registry.js";
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
  it("injects skills and subagents xml before the body", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      await writeText(join(workspace, ".pi", "skills", "review-guidelines.md"), "Always verify evidence.");
      await writeText(join(agentDir, "agents", "reviewer.md"), `---
name: reviewer
description: Review code
tools: read,grep
skills: review-guidelines
subagents: helper,missing
---
You are the reviewer.
`);
      await writeText(join(agentDir, "agents", "helper.md"), `---
name: helper
description: Helper agent
tools: read
skills: []
subagents: []
---
You are helper.
`);

      const registry = loadSubagentRegistry(workspace);
      const reviewer = registry.get("reviewer");
      expect(reviewer).toBeDefined();
      const prompt = buildSubagentSystemPrompt(reviewer!, registry, workspace);

      expect(prompt).toContain("<skills>");
      expect(prompt).toContain("<skill name=\"review-guidelines\">");
      expect(prompt).toContain("Always verify evidence.");
      expect(prompt).toContain("<subagents>");
      expect(prompt).toContain("<subagent name=\"helper\">Helper agent</subagent>");
      expect(prompt).toContain("<subagent name=\"missing\">Subagent configuration not found.</subagent>");
      expect(prompt.trim().endsWith("You are the reviewer.")).toBe(true);
    });
  });
  it("builds subagent xml from manual config objects", async () => {
    const workspace = await createTempWorkspace();
    const registry = new Map([
      ["caller", { name: "caller", description: "Caller", tools: ["read"], skills: [], subagents: ["child"], body: "Caller body", filePath: "caller.md", source: "project" as const }],
      ["child", { name: "child", description: "Child description", tools: ["read"], skills: [], subagents: [], body: "Child body", filePath: "child.md", source: "project" as const }],
    ]);

    const prompt = buildSubagentSystemPrompt(registry.get("caller")!, registry as any, workspace);
    expect(prompt).toContain("<subagents>");
    expect(prompt).toContain("<subagent name=\"child\">Child description</subagent>");
    expect(prompt.endsWith("Caller body")).toBe(true);
  });
});
