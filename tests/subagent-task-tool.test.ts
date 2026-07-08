import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSubagentTaskTool, type SubagentTaskToolDeps } from "../src/subagent/task-tool.js";
import { type SubagentSession, type SubagentSessionFactory } from "../src/subagent/runner.js";
import { subagentRegistry, type SubagentNode } from "../src/subagent/registry.js";
import { DEPTH_ENTRY } from "../src/subagent/depth.js";

afterEach(() => subagentRegistry.clear());

interface CapturedTool {
  name: string;
  renderCall: (args: Record<string, unknown>, theme: unknown, context: unknown) => { render: (width: number) => string[] };
  renderResult: (result: unknown, options: { expanded?: boolean; isPartial?: boolean }, theme: unknown, context: unknown) => { render: (width: number) => string[] };
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: ((partial: { content: Array<{ text: string }> }) => void) | undefined, ctx: never) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
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
  hasAgent: (name: string) => ["worker", "other"].includes(name),
  getMaxConcurrency: () => 2,
  factory: fakeFactory(),
  ...over,
});

const text = (r: { content: Array<{ text: string }> }): string => r.content.map((c) => c.text).join("");
const render = (component: { render: (width: number) => string[] }): string => component.render(200).join("\n");

describe("task tool", () => {
  it("rejects missing required args", async () => {
    const tool = registerAndCapture(baseDeps());
    expect((await tool.execute("1", { subagent_type: "worker" }, undefined, undefined, ctx())).isError).toBe(true);
    expect((await tool.execute("1", { prompt: "go" }, undefined, undefined, ctx())).isError).toBe(true);
  });

  it("reports a missing subagent_type with the currently available agents", async () => {
    const tool = registerAndCapture(baseDeps({ hasAgent: () => false }));
    const result = await tool.execute("1", { subagent_type: "ghost", description: "x", prompt: "go" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('does not exist');
    expect(text(result)).toContain('worker');
  });

  it("rejects an existing subagent_type outside the allowlist", async () => {
    // Intent: only agents in the caller's `subagents` allowlist may be delegated to.
    const tool = registerAndCapture(baseDeps());
    const result = await tool.execute("1", { subagent_type: "other", description: "x", prompt: "go" }, undefined, undefined, ctx());
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

  it("renders a compact task title, live progress, and final result separately", () => {
    // Intent: while running, the task row should show progress logs via partial result;
    // after completion, the call area stays compact and final output renders as the result.
    const tool = registerAndCapture(baseDeps());
    expect(render(tool.renderCall({ subagent_type: "worker", description: "audit" }, {}, { lastComponent: undefined }))).toContain("task: worker — audit");
    expect(render(tool.renderResult({ content: [{ type: "text", text: "started worker\n→ read" }] }, { isPartial: true }, {}, { lastComponent: undefined }))).toContain("→ read");
    expect(render(tool.renderResult({ content: [{ type: "text", text: '<task id="s" state="completed">ok</task>' }] }, { isPartial: false }, {}, { lastComponent: undefined }))).toContain("completed");
  });

  it("streams child progress updates through the task tool", async () => {
    // Intent: child-session events must surface as live task progress, then disappear when
    // the final result replaces the partial output.
    let listener: ((event: unknown) => void) | undefined;
    const factory: SubagentSessionFactory = {
      spawn: async () => ({
        sessionId: "child-progress",
        subscribe: (fn) => {
          listener = fn;
          return () => undefined;
        },
        prompt: async () => {
          listener?.({ type: "tool_execution_start", toolName: "read" });
          listener?.({ type: "tool_execution_end", toolName: "read", isError: false });
        },
        collect: () => ({ report: "ok", toolCount: 1 }),
        abort: vi.fn(),
        dispose: vi.fn(),
      }),
      resume: async ({ sessionId }) => ({
        sessionId,
        prompt: async () => undefined,
        collect: () => ({ report: "ok", toolCount: 0 }),
        abort: vi.fn(),
        dispose: vi.fn(),
      }),
    };
    const updates: string[] = [];
    const tool = registerAndCapture(baseDeps({ factory }));
    const result = await tool.execute("1", { subagent_type: "worker", description: "do", prompt: "go" }, undefined, (partial) => updates.push(text(partial)), ctx());
    expect(result.isError).toBeFalsy();
    expect(updates.join("\n")).toContain("started worker session child-progress");
    expect(updates.join("\n")).toContain("→ read");
    expect(updates.join("\n")).toContain("✓ read");
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
      sessionId: id,
      parentSessionId: "parent",
      rootSessionId: "parent",
      agentType: "worker",
      description: "d",
      depth: 2,
      status: "running",
      toolCount: 0,
      startedAt: 0,
    });
    subagentRegistry.upsert(running("r1"));
    subagentRegistry.upsert(running("r2"));
    const tool = registerAndCapture(baseDeps({ getMaxConcurrency: () => 2 }));
    const result = await tool.execute("1", { subagent_type: "worker", description: "do", prompt: "go" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("concurrency limit");
  });

  it("enforces maxConcurrency across parallel task calls in the same turn", async () => {
    // Intent: parallel `task` execution must reserve slots before async spawn so the third
    // call in one batch fails immediately instead of slipping past the concurrency guard.
    let nextId = 0;
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const factory: SubagentSessionFactory = {
      spawn: async () => ({
        sessionId: `spawned-${++nextId}`,
        prompt: async () => promptGate,
        collect: () => ({ report: "ok", toolCount: 0 }),
        abort: vi.fn(),
        dispose: vi.fn(),
      }),
      resume: async ({ sessionId }) => ({
        sessionId,
        prompt: async () => promptGate,
        collect: () => ({ report: "ok", toolCount: 0 }),
        abort: vi.fn(),
        dispose: vi.fn(),
      }),
    };
    const tool = registerAndCapture(baseDeps({ getMaxConcurrency: () => 2, factory }));

    const first = tool.execute("1", { subagent_type: "worker", description: "a", prompt: "go-a" }, undefined, undefined, ctx());
    const second = tool.execute("2", { subagent_type: "worker", description: "b", prompt: "go-b" }, undefined, undefined, ctx());
    const third = tool.execute("3", { subagent_type: "worker", description: "c", prompt: "go-c" }, undefined, undefined, ctx());

    await Promise.resolve();
    releasePrompt();
    const [r1, r2, r3] = await Promise.all([first, second, third]);
    expect(r1.isError).not.toBe(true);
    expect(r2.isError).not.toBe(true);
    expect(r3.isError).toBe(true);
    expect(text(r3)).toContain("concurrency limit");
  });

  it("refuses to resume a session that is currently running", async () => {
    // Intent: prevent double-driving one subagent session (P13).
    subagentRegistry.upsert({ sessionId: "s1", parentSessionId: "parent", rootSessionId: "parent", agentType: "worker", description: "d", depth: 2, status: "running", toolCount: 0, startedAt: 0 });
    const tool = registerAndCapture(baseDeps());
    const result = await tool.execute("1", { subagent_type: "worker", description: "do", prompt: "go", session_id: "s1" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("currently running");
  });
});
