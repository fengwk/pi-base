import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { subagentActivityStore } from "../src/subagent/activity.js";
import { buildSubagentSystemPrompt } from "../src/subagent/prompt.js";
import { getSubagentConfig, loadSubagentRegistry } from "../src/subagent/registry.js";
import { createSubagentSessionManager, getLatestSubagentInvocation, openSubagentSessionManager, readSubagentInvocations } from "../src/subagent/sessions.js";
import { preloadSubagentSkills } from "../src/subagent/skills.js";
import { buildTailLines, buildTranscriptLines, getFinalAssistantText, summarizeTailLines } from "../src/subagent/transcript.js";
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
  subagentActivityStore.clear();
});

describe("subagent internals", () => {
  it("loads flat and directory skills while ignoring unsafe and symlinked paths", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      await writeText(join(workspace, ".pi", "skills", "flat.md"), "flat content");
      await writeText(join(agentDir, "skills", "nested", "SKILL.md"), "nested content");
      await mkdir(join(workspace, ".pi", "skills-links"), { recursive: true });
      await symlink(join(agentDir, "skills", "nested"), join(workspace, ".pi", "skills", "nested-link"));

      const loaded = preloadSubagentSkills(["flat", "nested", "../escape", "missing"], workspace);
      expect(loaded).toEqual([
        { name: "flat", content: "flat content" },
        { name: "nested", content: "nested content" },
        { name: "../escape", content: '(Skill "../escape" skipped: name contains path traversal characters)' },
        { name: "missing", content: '(Skill "missing" not found in project or global skill locations)' },
      ]);
    });
  });
  it("loads skills from alternate roots and ignores symlinked flat files", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      const shared = await createTempWorkspace();
      await writeText(join(workspace, ".agents", "skills", "alt.md"), "alt content");
      await writeText(join(shared, "real.md"), "real content");
      await mkdir(join(workspace, ".pi", "skills"), { recursive: true });
      await symlink(join(shared, "real.md"), join(workspace, ".pi", "skills", "linked.md"));

      const loaded = preloadSubagentSkills(["alt", "linked"], workspace);
      expect(loaded).toEqual([
        { name: "alt", content: "alt content" },
        { name: "linked", content: '(Skill "linked" not found in project or global skill locations)' },
      ]);
    });
  });

  it("builds prompts without skills or subagents and escapes xml descriptions", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      await writeText(join(agentDir, "agents", "base.md"), `---
name: base
description: Base
tools: read
skills: []
subagents: []
---
Body only
`);
      await writeText(join(agentDir, "agents", "xml-helper.md"), `---
name: xml-helper
description: <unsafe>& helper
tools: read
skills: []
subagents: []
---
Helper body
`);
      await writeText(join(agentDir, "agents", "caller.md"), `---
name: caller
description: Caller
tools: read
skills: []
subagents: xml-helper
---
Caller body
`);

      const registry = loadSubagentRegistry(workspace);
      expect(buildSubagentSystemPrompt(getSubagentConfig(registry, "base")!, registry, workspace)).toBe("Body only");
      const callerPrompt = buildSubagentSystemPrompt(getSubagentConfig(registry, "caller")!, registry, workspace);
      expect(callerPrompt).toContain("<subagent name=\"xml-helper\">&lt;unsafe&gt;&amp; helper</subagent>");
    });
  });
  it("returns an empty registry when agent directories are missing and rejects invalid arrays", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      expect(loadSubagentRegistry(workspace).size).toBe(0);

      await writeText(join(agentDir, "agents", "broken.md"), `---
name: broken
description: Broken
tools:
  - read
  - 1
skills: []
subagents: []
---
Body
`);
      expect(() => loadSubagentRegistry(workspace)).toThrow("frontmatter.tools must be a string or an array of strings");
    });
  });

  it("tracks activity store state transitions", () => {
    subagentActivityStore.upsert({
      sessionId: "s1",
      mode: "new",
      name: "coder",
      status: "running",
      tailLines: ["line-1"],
      summary: "line-1",
      currentResponseText: "streaming",
      activeTools: ["read"],
    } as any);
    expect(subagentActivityStore.get("s1")?.status).toBe("running");
    expect(subagentActivityStore.list()).toHaveLength(1);

    subagentActivityStore.finish({
      sessionId: "s1",
      mode: "new",
      name: "coder",
      status: "completed",
      tailLines: ["done"],
      summary: "done",
    });
    expect(subagentActivityStore.get("s1")?.activeTools).toEqual([]);
    subagentActivityStore.clear();
    expect(subagentActivityStore.list()).toEqual([]);
  });

  it("formats transcript lines, tails, summaries, and final assistant text", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Inspect this" }] },
      { role: "assistant", content: [{ type: "text", text: "Thinking" }, { type: "toolCall", name: "read" }] },
      { role: "toolResult", content: [{ type: "text", text: "A".repeat(900) }] },
      { role: "bashExecution", command: "npm test", output: "pass\npass" },
      { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
      { role: "assistant", content: [{ type: "toolCall", name: "grep" }] },
    ];

    const lines = buildTranscriptLines(messages, { responseText: "Streaming tail", activeTools: ["write"] });
    expect(lines).toContain("[User]");
    expect(lines).toContain("[Assistant]");
    expect(lines).toContain("[Tool] read");
    expect(lines).toContain("[Result]");
    expect(lines.some((line) => line.includes("(truncated)"))).toBe(true);
    expect(lines).toContain("[Bash] npm test");
    expect(lines).toContain("[Assistant…]");
    expect(lines).toContain("[Running] write");
    expect(buildTailLines([], {}, 10)).toEqual(["(waiting for output...)"]);
    expect(summarizeTailLines(["", "tail line"])).toBe("tail line");
    expect(getFinalAssistantText(messages)).toBe("Final answer");
  });
  it("summarizes tails and final text for empty assistant content", () => {
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
      { role: "toolResult", content: "string result" },
      { role: "assistant", content: "plain assistant text" },
    ];

    const lines = buildTranscriptLines(messages, {});
    expect(lines).toContain("[Tool] read");
    expect(lines).toContain("plain assistant text");
    expect(summarizeTailLines(["x".repeat(130)])).toMatch(/\.\.\.$/);
    expect(getFinalAssistantText([{ role: "assistant", content: [] }])).toBe("");
  });
  it("handles unsupported transcript parts and empty assistant/tool sections", () => {
    expect(buildTranscriptLines([{ role: "user", content: { bad: true } }], {})).toEqual([]);
    expect(buildTranscriptLines([{ role: "assistant", content: [{ type: "image", text: "ignored" }] }], {})).toEqual([]);
  });

  it("reads invocation metadata and reopens child sessions", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      const manager = createSubagentSessionManager(workspace, "/tmp/parent.jsonl", agentDir);
      const header = manager.getHeader();
      expect(header?.parentSession).toBe("/tmp/parent.jsonl");
      manager.appendCustomEntry("pi-base-subagent-invocation", { name: "coder", timestamp: "1", parentSessionId: "p1" });
      manager.appendCustomEntry("other", { ignored: true });
      manager.appendCustomEntry("pi-base-subagent-invocation", { name: "reviewer", timestamp: "2", callerSessionId: "c1" });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }] } as any);

      const reopened = await openSubagentSessionManager(workspace, manager.getSessionId(), agentDir);
      const invocations = readSubagentInvocations(reopened.getEntries());
      expect(invocations).toEqual([
        { name: "coder", timestamp: "1", parentSessionId: "p1", callerSessionId: undefined },
        { name: "reviewer", timestamp: "2", parentSessionId: undefined, callerSessionId: "c1" },
      ]);
      expect(getLatestSubagentInvocation(reopened.getEntries())?.name).toBe("reviewer");
    });
  });

  it("throws when reopening an unknown subagent session", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      await expect(openSubagentSessionManager(workspace, "missing", agentDir)).rejects.toThrow("Unknown subagent session_id");
    });
  });
  it("ignores malformed invocation entries and returns undefined for empty chains", () => {
    const malformedEntries: any[] = [
      { type: "custom", customType: "pi-base-subagent-invocation", data: { timestamp: "1" } },
      { type: "custom", customType: "pi-base-subagent-invocation", data: null },
      { type: "custom", customType: "other", data: { name: "ignored" } },
    ];

    expect(readSubagentInvocations(malformedEntries as any)).toEqual([]);
    expect(getLatestSubagentInvocation(malformedEntries as any)).toBeUndefined();
  });
});
