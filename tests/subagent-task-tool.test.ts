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
  getIdleTimeoutMs: () => undefined,
  getMaxTurns: () => undefined,
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

  it("renders the task call without labels and shows summarized live output separately from the final report", () => {
    // Intent: delegated prompts must remain inspectable without noisy labels,
    // while the running view should expose a live summary + rolling transcript.
    const tool = registerAndCapture(baseDeps());
    const call = render(
      tool.renderCall(
        { subagent_type: "worker", description: "audit", prompt: "line 1\nline 2" },
        {},
        { lastComponent: undefined },
      ),
    );
    expect(call).toContain('task worker --description "audit"');
    expect(call).toContain("line 1");
    expect(call).toContain("line 2");
    expect(call).not.toContain("Command");
    expect(call).not.toContain("Prompt");

    const partial = render(
      tool.renderResult(
        {
          content: [{ type: "text", text: "" }],
          details: {
            progress: true,
            progressEntries: ['→ read {"path":"src/a.ts"}', '✓ read {"path":"src/a.ts"}'],
            turns: 1,
            toolCalls: 1,
          },
        },
        { isPartial: true },
        {},
        { lastComponent: undefined },
      ),
    );
    expect(partial).toContain("running · turns: 1 · tool calls: 1");
    expect(partial).toContain('→ read {"path":"src/a.ts"}');
    expect(partial).toContain('✓ read {"path":"src/a.ts"}');
    expect(partial).not.toContain("1|alpha");

    const final = render(
      tool.renderResult(
        {
          content: [
            {
              type: "text",
              text: '<task id="s" state="completed">\n<task_result>\nREPORT\n</task_result>\n</task>',
            },
          ],
          details: { result: { sessionId: "s", state: "completed", report: "REPORT" } },
        },
        { isPartial: false },
        {},
        { lastComponent: undefined },
      ),
    );
    expect(final).toContain("task completed");
    expect(final).toContain("Result");
    expect(final).toContain("REPORT");
    expect(final).not.toContain("running · turns:");
  });

  it("shows a five-entry rolling tail for live progress", () => {
    const tool = registerAndCapture(baseDeps());
    const partial = render(
      tool.renderResult(
        {
          content: [{ type: "text", text: "" }],
          details: {
            progress: true,
            progressEntries: [
              "start",
              '→ read {"path":"a"}',
              '✓ read {"path":"a"}',
              '→ grep {"pattern":"b"}',
              '✓ grep {"pattern":"b"}',
              '→ write {"path":"c"}',
              '✓ write {"path":"c"}',
            ],
            turns: 1,
            toolCalls: 3,
          },
        },
        { isPartial: true },
        {},
        { lastComponent: undefined },
      ),
    );
    expect(partial).toContain("running · turns: 1 · tool calls: 3");
    expect(partial).not.toContain("start");
    expect(partial).not.toContain('→ read {"path":"a"}');
    expect(partial).toContain('✓ read {"path":"a"}');
    expect(partial).toContain('→ grep {"pattern":"b"}');
    expect(partial).toContain('✓ grep {"pattern":"b"}');
    expect(partial).toContain('→ write {"path":"c"}');
    expect(partial).toContain('✓ write {"path":"c"}');
  });

  it("collapses long final task reports until expanded", () => {
    // Intent: folded task results should respect the task renderer's collapsed line budget.
    const tool = registerAndCapture(baseDeps());
    const report = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = {
      content: [{ type: "text", text: "" }],
      details: { result: { sessionId: "s", state: "completed", report } },
    };
    const collapsed = render(
      tool.renderResult(result, { isPartial: false, expanded: false }, {}, { lastComponent: undefined }),
    );
    expect(collapsed).toContain("line 10");
    expect(collapsed).not.toContain("line 11");
    expect(collapsed).toContain("expand for full report");

    const expanded = render(
      tool.renderResult(result, { isPartial: false, expanded: true }, {}, { lastComponent: undefined }),
    );
    expect(expanded).toContain("line 12");
    expect(expanded).not.toContain("expand for full report");
  });

  it("streams child progress updates through the task tool", async () => {
    // Intent: child-session events must surface as a concise running tail,
    // while still reflecting assistant turn counts even for tool-only turns.
    let listener: ((event: unknown) => void) | undefined;
    const factory: SubagentSessionFactory = {
      spawn: async () => ({
        sessionId: "child-progress",
        subscribe: (fn) => {
          listener = fn;
          return () => undefined;
        },
        prompt: async () => {
          listener?.({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "src/a.ts" } });
          listener?.({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", isError: false, result: { content: [{ type: "text", text: "path: src/a.ts\n1|alpha" }] } });
          listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }] } });
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
    expect(updates.join("\n")).toContain("running · turns: 1 · tool calls: 1");
    expect(updates.join("\n")).toContain('→ read {"path":"src/a.ts"}');
    expect(updates.join("\n")).toContain('✓ read {"path":"src/a.ts"}');
    expect(updates.join("\n")).not.toContain("path: src/a.ts");
    expect(updates.join("\n")).not.toContain("assistant");
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

  it("applies maxConcurrency to resumed subagent sessions too", async () => {
    // Intent: resume should consume the same concurrency budget as a new child run.
    subagentRegistry.upsert({ sessionId: "other", parentSessionId: "parent", rootSessionId: "parent", agentType: "worker", description: "d", depth: 2, status: "running", toolCount: 0, startedAt: 0 });
    const tool = registerAndCapture(baseDeps({ getMaxConcurrency: () => 1 }));
    const result = await tool.execute("1", { subagent_type: "worker", description: "do", prompt: "go", session_id: "resume-me" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("concurrency limit");
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
