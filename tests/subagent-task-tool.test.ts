import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSubagentTaskTool, type SubagentTaskToolDeps } from "../src/subagent/task-tool.js";
import { type SubagentSession, type SubagentSessionFactory } from "../src/subagent/runner.js";
import { subagentRegistry, type SubagentNode } from "../src/subagent/registry.js";
import { DEPTH_ENTRY } from "../src/subagent/depth.js";

afterEach(() => subagentRegistry.clear());

interface CapturedTool {
  name: string;
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: never) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
}

function registerAndCapture(deps: SubagentTaskToolDeps): CapturedTool {
  let captured: CapturedTool | undefined;
  registerSubagentTaskTool({ registerTool: (tool: unknown) => { captured = tool as CapturedTool; } } as never, deps);
  return captured!;
}

function ctx(sessionId = "parent", depth?: number): never {
  const entries = depth ? [{ type: "custom", customType: DEPTH_ENTRY, data: { depth } }] : [];
  return { cwd: "/tmp/work", sessionManager: { getSessionId: () => sessionId, getEntries: () => entries } } as never;
}

function fakeFactory(onSpawn?: (childDepth: number) => void): SubagentSessionFactory {
  const make = (id: string): SubagentSession => ({
    sessionId: id,
    prompt: async () => undefined,
    collect: () => ({ report: "ok", toolCount: 0 }),
    abort: vi.fn(),
    dispose: vi.fn(),
  });
  return {
    spawn: async ({ childDepth }) => {
      onSpawn?.(childDepth);
      return make("spawned");
    },
    resume: async ({ sessionId }) => make(sessionId),
  };
}

const baseDeps = (over: Partial<SubagentTaskToolDeps> = {}): SubagentTaskToolDeps => ({
  getActiveAgentSubagents: () => ["worker"],
  getMaxConcurrency: () => 2,
  factory: fakeFactory(),
  ...over,
});

const text = (r: { content: Array<{ text: string }> }): string => r.content.map((c) => c.text).join("");

describe("task tool", () => {
  it("rejects missing required args", async () => {
    const tool = registerAndCapture(baseDeps());
    expect((await tool.execute("1", { subagent_type: "worker" }, undefined, undefined, ctx())).isError).toBe(true);
    expect((await tool.execute("1", { prompt: "go" }, undefined, undefined, ctx())).isError).toBe(true);
  });

  it("rejects a subagent_type outside the allowlist", async () => {
    // Intent: only agents in the caller's `subagents` allowlist may be delegated to.
    const tool = registerAndCapture(baseDeps());
    const result = await tool.execute("1", { subagent_type: "hacker", description: "x", prompt: "go" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not allowed");
  });

  it("delegates a valid task and returns the completed envelope", async () => {
    const tool = registerAndCapture(baseDeps());
    const result = await tool.execute("1", { subagent_type: "worker", description: "do", prompt: "go" }, undefined, undefined, ctx());
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('id="spawned"');
    expect(text(result)).toContain("state=\"completed\"");
  });

  it("passes childDepth = parent depth + 1", async () => {
    // Intent: depth must increment per level so maxDepth can withhold `task` at the leaf.
    let seenDepth = 0;
    const tool = registerAndCapture(baseDeps({ factory: fakeFactory((d) => { seenDepth = d; }) }));
    await tool.execute("1", { subagent_type: "worker", description: "do", prompt: "go" }, undefined, undefined, ctx("parent", 2));
    expect(seenDepth).toBe(3);
  });

  it("enforces the per-session concurrency cap for new spawns", async () => {
    // Intent: a session running maxConcurrency subagents must reject further new delegations.
    const running = (id: string): SubagentNode => ({
      sessionId: id, parentSessionId: "parent", agentType: "worker", description: "d", depth: 2, status: "running", toolCount: 0, startedAt: 0,
    });
    subagentRegistry.upsert(running("r1"));
    subagentRegistry.upsert(running("r2"));
    const tool = registerAndCapture(baseDeps({ getMaxConcurrency: () => 2 }));
    const result = await tool.execute("1", { subagent_type: "worker", description: "do", prompt: "go" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("concurrency limit");
  });

  it("refuses to resume a session that is currently running", async () => {
    // Intent: prevent double-driving one subagent session (P13).
    subagentRegistry.upsert({ sessionId: "s1", parentSessionId: "parent", agentType: "worker", description: "d", depth: 2, status: "running", toolCount: 0, startedAt: 0 });
    const tool = registerAndCapture(baseDeps());
    const result = await tool.execute("1", { subagent_type: "worker", description: "do", prompt: "go", session_id: "s1" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("currently running");
  });
});
