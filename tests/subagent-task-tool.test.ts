import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSubagentTaskTool, type SubagentTaskToolDeps } from "../src/subagent/task-tool.js";
import {
  PI_BASE_MODULE_INSTANCE_MARKER,
  PI_BASE_MODULE_INSTANCE_TOKEN,
  type SubagentSession,
  type SubagentSessionFactory,
} from "../src/subagent/runner.js";
import { subagentRegistry, type SubagentNode } from "../src/subagent/registry.js";
import { DEPTH_ENTRY, ROOT_SESSION_ENTRY, rootSessionEntryData } from "../src/subagent/depth.js";

afterEach(() => subagentRegistry.clear());

interface CapturedTool {
  name: string;
  description: string;
  parameters: any;
  renderCall: (args: Record<string, unknown>, theme: unknown, context: unknown) => { render: (width: number) => string[] };
  renderResult: (result: unknown, options: { expanded?: boolean; isPartial?: boolean }, theme: unknown, context: unknown) => { render: (width: number) => string[] };
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: ((partial: { content: Array<{ text: string }> }) => void) | undefined, ctx: never) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
}

function registerAndCapture(deps: SubagentTaskToolDeps): CapturedTool {
  let captured: CapturedTool | undefined;
  registerSubagentTaskTool({ registerTool: (tool: unknown) => { captured = tool as CapturedTool; } } as never, deps);
  return captured!;
}

function ctx(sessionId = "parent", depth?: number, rootSessionId?: string): never {
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  if (depth !== undefined) entries.push({ type: "custom", customType: DEPTH_ENTRY, data: { depth } });
  if (rootSessionId) entries.push({ type: "custom", customType: ROOT_SESSION_ENTRY, data: rootSessionEntryData(rootSessionId) });
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
  getMaxTotalConcurrency: () => undefined,
  getIdleTimeoutMs: () => undefined,
  getMaxTurns: () => 50,
  factory: fakeFactory(),
  ...over,
});

const text = (r: { content: Array<{ text: string }> }): string => r.content.map((c) => c.text).join("");
const render = (component: { render: (width: number) => string[] }): string => component.render(200).join("\n");

describe("task tool", () => {
  it("marks the definition with the owning pi-base module instance", () => {
    // Intent: child session startup uses this non-enumerable identity marker to reject a second
    // module copy whose process-local registries and permission hosts would be disconnected.
    const tool = registerAndCapture(baseDeps()) as unknown as Record<PropertyKey, unknown>;
    expect(tool[PI_BASE_MODULE_INSTANCE_MARKER]).toBe(PI_BASE_MODULE_INSTANCE_TOKEN);
  });

  it("rejects missing required args", async () => {
    const tool = registerAndCapture(baseDeps());
    expect((await tool.execute("1", { subagent_type: "worker" }, undefined, undefined, ctx())).isError).toBe(true);
    expect((await tool.execute("1", { prompt: "go" }, undefined, undefined, ctx())).isError).toBe(true);
  });

  it("reports a missing subagent_type with the currently available agents", async () => {
    const tool = registerAndCapture(baseDeps({ hasAgent: () => false }));
    const result = await tool.execute("1", { subagent_type: "ghost", prompt: "go" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('does not exist');
    expect(text(result)).toContain('worker');
  });

  it("rejects an existing subagent_type outside the allowlist", async () => {
    // Intent: only agents in the caller's `subagents` allowlist may be delegated to.
    const tool = registerAndCapture(baseDeps());
    const result = await tool.execute("1", { subagent_type: "other", prompt: "go" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not allowed");
  });

  it("delegates a valid task and returns the completed envelope", async () => {
    const tool = registerAndCapture(baseDeps());
    const result = await tool.execute("1", { subagent_type: "worker", prompt: "go" }, undefined, undefined, ctx());
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('id="spawned"');
    expect(text(result)).toContain("state=\"completed\"");
  });

  it("advertises the configured default maxTurns", () => {
    // Intent: the tool contract exposes the effective registration-workspace default while the
    // runtime resolver remains authoritative for each invocation's ctx.cwd.
    const tool = registerAndCapture(baseDeps({ getMaxTurns: () => 7 }));
    expect(tool.description).toContain("The default is `7`");
    expect(tool.parameters.properties.maxTurns.description).toContain("Default: 7");
  });

  it("uses task maxTurns to override the configured budget", async () => {
    // Intent: omit the override to retain the config budget, then prove a smaller call budget
    // reaches the runner's phase-report steer path for the same child behavior.
    const steer = vi.fn(async () => undefined);
    const factory: SubagentSessionFactory = {
      spawn: async () => {
        let listener: ((event: unknown) => void) | undefined;
        return {
          sessionId: "child-budget",
          prompt: async () => {
            listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }] } });
            listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "report" }] } });
          },
          collect: () => ({ report: "report", toolCount: 1 }),
          subscribe: (next) => {
            listener = next;
            return () => undefined;
          },
          steer,
          abort: vi.fn(),
          dispose: vi.fn(),
        };
      },
      resume: async () => { throw new Error("unused"); },
    };
    const tool = registerAndCapture(baseDeps({ getMaxTurns: () => 2, factory }));

    await tool.execute("configured", { subagent_type: "worker", prompt: "go" }, undefined, undefined, ctx());
    expect(steer).not.toHaveBeenCalled();

    await tool.execute("override", { subagent_type: "worker", prompt: "go", maxTurns: 1 }, undefined, undefined, ctx());
    expect(steer).toHaveBeenCalledWith(expect.stringContaining("phase report"));
  });

  it("rejects a non-positive task maxTurns override", async () => {
    // Intent: direct execution in tests bypasses TypeBox validation, so the tool also protects
    // the runner from an invalid budget supplied by a programmatic caller.
    const tool = registerAndCapture(baseDeps());
    const result = await tool.execute("1", { subagent_type: "worker", prompt: "go", maxTurns: 0 }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("maxTurns");
  });

  it("renders only the task command and prompt while running regardless of expansion", () => {
    // Intent: live progress belongs in the /subagent panel, so task history remains stable in every state.
    const tool = registerAndCapture(baseDeps());
    const call = render(
      tool.renderCall(
        { subagent_type: "worker", prompt: "line 1\nline 2", maxTurns: 3 },
        {},
        { lastComponent: undefined },
      ),
    );
    expect(call).toContain("task worker");
    expect(call).toContain("--max-turns 3");
    expect(call).not.toContain("--description");
    expect(call).toContain("line 1");
    expect(call).toContain("line 2");
    expect(call).not.toContain("Command");
    expect(call).not.toContain("Prompt");

    const partialResult = {
      content: [{ type: "text", text: "running · turns: 1 · tool calls: 1" }],
      details: {
        progress: true,
        progressEntries: ['→ read {"path":"src/a.ts"}', '✓ read {"path":"src/a.ts"}'],
        turns: 1,
        toolCalls: 1,
      },
    };
    expect(render(
      tool.renderResult(partialResult, { isPartial: true, expanded: false }, {}, { lastComponent: undefined }),
    )).toBe("");
    expect(render(
      tool.renderResult(partialResult, { isPartial: true, expanded: true }, {}, { lastComponent: undefined }),
    )).toBe("");

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

  it("uses configured collapsed task result budgets until expanded", () => {
    // Intent: final task results must respect the same render.* line/char policy as other tools.
    const tool = registerAndCapture(baseDeps({
      getCollapsedResultLines: () => 5,
      getCollapsedResultMaxChars: () => 1000,
    }));
    const report = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = {
      content: [{ type: "text", text: "" }],
      details: { result: { sessionId: "s", state: "completed", report } },
    };
    const collapsed = render(
      tool.renderResult(result, { isPartial: false, expanded: false }, {}, { lastComponent: undefined, cwd: "/tmp/work" }),
    );
    expect(collapsed).toContain("line 4");
    expect(collapsed).not.toContain("line 5");
    expect(collapsed).toContain("ctrl+o to expand");

    const expanded = render(
      tool.renderResult(result, { isPartial: false, expanded: true }, {}, { lastComponent: undefined, cwd: "/tmp/work" }),
    );
    expect(expanded).toContain("line 12");
    expect(expanded).not.toContain("ctrl+o to expand");
  });

  it("keeps child progress out of task partial updates while updating the registry", async () => {
    // Intent: live counters belong to the registry-backed widget/overlay, not the historical task block.
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
    const result = await tool.execute("1", { subagent_type: "worker", prompt: "go" }, undefined, (partial) => updates.push(text(partial)), ctx());
    expect(result.isError).toBeFalsy();
    expect(updates).toEqual([]);
    expect(subagentRegistry.get("child-progress")).toMatchObject({
      status: "done",
      turns: 1,
      toolCount: 1,
      lastActivity: "completed",
    });
  });

  it("passes childDepth = parent depth + 1", async () => {
    // Intent: depth must increment per level so maxDepth can withhold `task` at the leaf.
    let seenDepth = 0;
    const tool = registerAndCapture(baseDeps({ factory: fakeFactory((d) => { seenDepth = d; }) }));
    await tool.execute("1", { subagent_type: "worker", prompt: "go" }, undefined, undefined, ctx("parent", 2));
    expect(seenDepth).toBe(3);
  });

  it("enforces the per-session concurrency cap for new spawns", async () => {
    // Intent: a session running maxConcurrency subagents must reject further new delegations.
    const running = (id: string): SubagentNode => ({
      sessionId: id,
      parentSessionId: "parent",
      rootSessionId: "parent",
      agentType: "worker",
      depth: 2,
      status: "running",
      turns: 0,
      toolCount: 0,
      startedAt: 0,
    });
    subagentRegistry.upsert(running("r1"));
    subagentRegistry.upsert(running("r2"));
    const tool = registerAndCapture(baseDeps({ getMaxConcurrency: () => 2 }));
    const result = await tool.execute("1", { subagent_type: "worker", prompt: "go" }, undefined, undefined, ctx());
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

    const first = tool.execute("1", { subagent_type: "worker", prompt: "go-a" }, undefined, undefined, ctx());
    const second = tool.execute("2", { subagent_type: "worker", prompt: "go-b" }, undefined, undefined, ctx());
    const third = tool.execute("3", { subagent_type: "worker", prompt: "go-c" }, undefined, undefined, ctx());

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
    subagentRegistry.upsert({ sessionId: "other", parentSessionId: "parent", rootSessionId: "parent", agentType: "worker", depth: 2, status: "running", turns: 0, toolCount: 0, startedAt: 0 });
    const tool = registerAndCapture(baseDeps({ getMaxConcurrency: () => 1 }));
    const result = await tool.execute("1", { subagent_type: "worker", prompt: "go", session_id: "resume-me" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("concurrency limit");
  });

  it("enforces maxTotalConcurrency across the whole root delegation tree", async () => {
    // Intent: nested delegation must respect the root-wide total cap even when the current parent
    // still has free direct-child capacity.
    subagentRegistry.upsert({
      sessionId: "sibling-child",
      parentSessionId: "sibling-parent",
      rootSessionId: "root-session",
      agentType: "worker",
      depth: 2,
      status: "running",
      turns: 0,
      toolCount: 0,
      startedAt: 0,
    });
    const tool = registerAndCapture(baseDeps({ getMaxConcurrency: () => 10, getMaxTotalConcurrency: () => 1 }));
    const result = await tool.execute("1", { subagent_type: "worker", prompt: "go" }, undefined, undefined, ctx("nested-parent", 2, "root-session"));
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("total concurrency limit");
  });

  it("enforces maxTotalConcurrency across parallel starts under the same root", async () => {
    // Intent: the root-wide cap must count in-flight starts too, otherwise sibling branches could
    // slip past the total limit before their child sessions register as running.
    let nextId = 0;
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const factory: SubagentSessionFactory = {
      spawn: async () => ({
        sessionId: `spawned-total-${++nextId}`,
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
    const tool = registerAndCapture(baseDeps({ getMaxConcurrency: () => 10, getMaxTotalConcurrency: () => 2, factory }));

    const first = tool.execute("1", { subagent_type: "worker", prompt: "go-a" }, undefined, undefined, ctx("parent-a", 2, "root-session"));
    const second = tool.execute("2", { subagent_type: "worker", prompt: "go-b" }, undefined, undefined, ctx("parent-b", 2, "root-session"));
    const third = tool.execute("3", { subagent_type: "worker", prompt: "go-c" }, undefined, undefined, ctx("parent-c", 2, "root-session"));

    await Promise.resolve();
    releasePrompt();
    const [r1, r2, r3] = await Promise.all([first, second, third]);
    expect(r1.isError).not.toBe(true);
    expect(r2.isError).not.toBe(true);
    expect(r3.isError).toBe(true);
    expect(text(r3)).toContain("total concurrency limit");
  });

  it("refuses concurrent resumes before the first session finishes opening", async () => {
    // Intent: the resume guard must cover the factory-open window before the child appears as
    // running in the registry, otherwise two SessionManagers can write the same JSONL session.
    let resumeCalls = 0;
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const factory: SubagentSessionFactory = {
      spawn: async () => { throw new Error("unused"); },
      resume: async ({ sessionId }) => {
        resumeCalls += 1;
        await resumeGate;
        return {
          sessionId,
          prompt: async () => undefined,
          collect: () => ({ report: "ok", toolCount: 0 }),
          abort: vi.fn(),
          dispose: vi.fn(),
        };
      },
    };
    const tool = registerAndCapture(baseDeps({ factory }));

    const first = tool.execute("1", { subagent_type: "worker", prompt: "go-a", session_id: "same" }, undefined, undefined, ctx());
    const second = await tool.execute("2", { subagent_type: "worker", prompt: "go-b", session_id: "same" }, undefined, undefined, ctx());

    expect(second.isError).toBe(true);
    expect(text(second)).toContain("currently running");
    expect(resumeCalls).toBe(1);
    releaseResume();
    expect((await first).isError).not.toBe(true);
  });

  it("refuses to resume a session that is currently running", async () => {
    // Intent: prevent double-driving one subagent session (P13).
    subagentRegistry.upsert({ sessionId: "s1", parentSessionId: "parent", rootSessionId: "parent", agentType: "worker", depth: 2, status: "running", turns: 0, toolCount: 0, startedAt: 0 });
    const tool = registerAndCapture(baseDeps());
    const result = await tool.execute("1", { subagent_type: "worker", prompt: "go", session_id: "s1" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("currently running");
  });
});
