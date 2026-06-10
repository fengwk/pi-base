import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSubagentConfig, listSubagentConfigs, loadSubagentRegistry } from "../src/task/registry.js";
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

async function writeAgentFile(dir: string, name: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), content, "utf8");
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("subagent registry", () => {
  it("loads global and project subagents with project override", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(join(agentDir, "subagents"), "reviewer", `---
name: reviewer
description: Global reviewer
tools: read,grep
skills: global-skill
model: anthropic/claude-sonnet-4
thinking: medium
---
Global body
`);
      await writeAgentFile(join(workspace, ".pi", "subagents"), "reviewer", `---
name: reviewer
description: Project reviewer
tools:
  - read
  - find
skills:
  - project-skill
model: haiku
thinking: high
---
Project body
`);
      await writeAgentFile(join(workspace, ".pi", "subagents"), "helper", `---
name: helper
description: Helper
tools: read
skills: []
---
Helper body
`);

      const registry = loadSubagentRegistry(workspace);
      expect(listSubagentConfigs(registry).map((item) => item.name)).toEqual(["helper", "reviewer"]);
      expect(getSubagentConfig(registry, "reviewer")).toMatchObject({
        description: "Project reviewer",
        tools: ["read", "find"],
        skills: ["project-skill"],
        model: "haiku",
        thinking: "high",
        source: "project",
        body: "Project body",
      });
    });
  });

  it("supports csv strings and case-insensitive lookup", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(join(agentDir, "subagents"), "coder", `---
name: coder
description: Coder
tools: read, grep, write
skills: style, tests
model: claude
thinking: low
---
Coder body
`);

      const registry = loadSubagentRegistry(workspace);
      expect(getSubagentConfig(registry, "CODER")).toMatchObject({
        tools: ["read", "grep", "write"],
        skills: ["style", "tests"],
        model: "claude",
        thinking: "low",
      });
    });
  });

  it("rejects mismatched file and frontmatter names", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(join(agentDir, "subagents"), "wrong-name", `---
name: right-name
description: Broken
tools: read
skills: []
---
Body
`);

      expect(() => loadSubagentRegistry(workspace)).toThrow("frontmatter.name must match the file name");
    });
  });

  it("rejects empty tools, empty body, and invalid thinking levels", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspaceWithEmptyTools = await createTempWorkspace();
      await writeAgentFile(join(agentDir, "subagents"), "empty-tools", `---
name: empty-tools
description: Broken
tools: []
skills: []
---
Body
`);
      expect(() => loadSubagentRegistry(workspaceWithEmptyTools)).toThrow("frontmatter.tools must list at least one tool");
    });

    await withTempAgentDir(async (agentDir) => {
      const workspaceWithEmptyBody = await createTempWorkspace();
      await writeAgentFile(join(agentDir, "subagents"), "empty-body", `---
name: empty-body
description: Broken
tools: read
skills: []
---
`);
      expect(() => loadSubagentRegistry(workspaceWithEmptyBody)).toThrow("markdown body must not be empty");
    });

    await withTempAgentDir(async (agentDir) => {
      const workspaceWithInvalidThinking = await createTempWorkspace();
      await writeAgentFile(join(agentDir, "subagents"), "invalid-thinking", `---
name: invalid-thinking
description: Broken
tools: read
skills: []
thinking: ultra
---
Body
`);
      expect(() => loadSubagentRegistry(workspaceWithInvalidThinking)).toThrow("frontmatter.thinking must be one of");
    });
  });
});
