import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectFromMessages,
  formatRunResult,
  runSubagent,
  subagentSessionDir,
  type SubagentSession,
  type SubagentSessionFactory,
} from "../src/subagent/runner.js";
import { ROOT_SESSION_ENTRY, rootSessionEntryData } from "../src/subagent/depth.js";
import { subagentRegistry } from "../src/subagent/registry.js";
import { createTempWorkspace } from "./helpers.js";

afterEach(() => subagentRegistry.clear());

function fakeCtx(sessionId = "parent", entries: Array<{ type: string; customType?: string; data?: unknown }> = []): never {
  return { cwd: "/tmp/work", sessionManager: { getSessionId: () => sessionId, getEntries: () => entries } } as never;
}

function handle(id: string, opts: { prompt?: () => Promise<void>; report?: string; toolCount?: number }): SubagentSession {
  return {
    sessionId: id,
    prompt: opts.prompt ?? (async () => undefined),
    collect: () => ({ report: opts.report, toolCount: opts.toolCount ?? 0 }),
    abort: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("runSubagent", () => {
  it("spawns, marks running then done, and returns the report + session id", async () => {
    // Intent: the happy path must return a real session id + report and reflect done in the registry.
    const factory: SubagentSessionFactory = {
      spawn: async () => handle("child-1", { report: "final report", toolCount: 3 }),
      resume: async () => handle("child-1", {}),
    };
    const result = await runSubagent(
      fakeCtx(),
      { agentType: "worker", prompt: "go", childDepth: 2 },
      factory,
    );
    expect(result).toEqual({ sessionId: "child-1", state: "completed", report: "final report" });
    const node = subagentRegistry.get("child-1")!;
    expect(node.status).toBe("done");
    expect(node.toolCount).toBe(3);
    expect(node.parentSessionId).toBe("parent");
    expect(node.rootSessionId).toBe("parent");
  });

  it("preserves the caller's persisted root-session id in registry nodes", async () => {
    const factory: SubagentSessionFactory = {
      spawn: async () => handle("child-rooted", { report: "ok" }),
      resume: async () => handle("child-rooted", {}),
    };
    await runSubagent(
      fakeCtx("child-parent", [{ type: "custom", customType: ROOT_SESSION_ENTRY, data: rootSessionEntryData("root-123") }]),
      { agentType: "worker", prompt: "go", childDepth: 3 },
      factory,
    );
    expect(subagentRegistry.get("child-rooted")?.rootSessionId).toBe("root-123");
  });

  it("returns error state (not throwing) when the subagent prompt fails", async () => {
    // Intent: a failing subagent must not break the parent turn; it returns error + session id.
    const factory: SubagentSessionFactory = {
      spawn: async () => handle("child-err", { prompt: async () => { throw new Error("boom"); } }),
      resume: async () => handle("child-err", {}),
    };
    const result = await runSubagent(fakeCtx(), { agentType: "w", prompt: "p", childDepth: 2 }, factory);
    expect(result.state).toBe("error");
    expect(result.sessionId).toBe("child-err");
    expect(result.error).toContain("boom");
    expect(subagentRegistry.get("child-err")!.status).toBe("error");
  });

  it("cascades parent-turn cancellation to the subagent and reports cancelled", async () => {
    // Intent: aborting the parent turn must abort the child session and yield a cancelled result.
    const controller = new AbortController();
    const child = handle("child-cx", {
      prompt: async () => {
        controller.abort();
        throw new Error("interrupted");
      },
    });
    const factory: SubagentSessionFactory = { spawn: async () => child, resume: async () => child };
    const result = await runSubagent(
      fakeCtx(),
      { agentType: "w", prompt: "p", childDepth: 2, signal: controller.signal },
      factory,
    );
    expect(result.state).toBe("cancelled");
    expect(result.error).toContain("Cancelled by user");
    expect(child.abort).toHaveBeenCalledTimes(1);
    expect(subagentRegistry.get("child-cx")!.status).toBe("cancelled");
  });

  it("treats a prompt that resolves after abort as cancelled instead of completed", async () => {
    // Intent: Pi resolves aborted child prompts with a terminal assistant message; task must still
    // surface cancellation rather than incorrectly reporting completion.
    const controller = new AbortController();
    const child = handle("child-cx-resolved", {
      prompt: async () => {
        controller.abort();
      },
      report: "should not surface",
      toolCount: 4,
    });
    const factory: SubagentSessionFactory = { spawn: async () => child, resume: async () => child };
    const result = await runSubagent(
      fakeCtx(),
      { agentType: "w", prompt: "p", childDepth: 2, signal: controller.signal },
      factory,
    );
    expect(result.state).toBe("cancelled");
    expect(result.error).toContain("Cancelled by user");
    expect(result.error).toContain("child-cx-resolved");
    expect(child.abort).toHaveBeenCalledTimes(1);
    expect(subagentRegistry.get("child-cx-resolved")!.status).toBe("cancelled");
  });

  it("propagates a parent abort to already-running descendant subagents in the same tree", async () => {
    // Intent: user cancellation in the root session should fan out to all live descendants, not
    // rely on each intermediate parent session to relay aborts correctly.
    const topController = new AbortController();
    let releaseGrandchild!: () => void;
    const grandchild: SubagentSession = {
      sessionId: "grandchild-running",
      prompt: () => new Promise<void>((_resolve, reject) => {
        releaseGrandchild = () => reject(new Error("grandchild aborted"));
      }),
      collect: () => ({ report: undefined, toolCount: 0 }),
      abort: vi.fn(() => releaseGrandchild()),
      dispose: vi.fn(),
    };
    const nestedFactory: SubagentSessionFactory = {
      spawn: async () => grandchild,
      resume: async () => grandchild,
    };
    const childAbort = vi.fn(() => undefined);
    const child: SubagentSession = {
      sessionId: "child-parent",
      prompt: async () => {
        const nested = runSubagent(
          fakeCtx("child-parent", [{ type: "custom", customType: ROOT_SESSION_ENTRY, data: rootSessionEntryData("root-session") }]),
          { agentType: "leaf", prompt: "leaf", childDepth: 3 },
          nestedFactory,
        );
        await Promise.resolve();
        topController.abort();
        await nested;
      },
      collect: () => ({ report: undefined, toolCount: 0 }),
      abort: childAbort,
      dispose: vi.fn(),
    };
    const topFactory: SubagentSessionFactory = {
      spawn: async () => child,
      resume: async () => child,
    };
    const result = await runSubagent(
      fakeCtx("root-session"),
      { agentType: "worker", prompt: "go", childDepth: 2, signal: topController.signal },
      topFactory,
    );
    expect(result.state).toBe("cancelled");
    expect(childAbort).toHaveBeenCalledTimes(1);
    expect(grandchild.abort).toHaveBeenCalledTimes(1);
    expect(subagentRegistry.get("child-parent")!.status).toBe("cancelled");
  });

  it("returns an error result when the session cannot even be created", async () => {
    // Intent: a factory failure (e.g. resume of a missing session) must surface as error, not throw.
    const factory: SubagentSessionFactory = {
      spawn: async () => { throw new Error("spawn failed"); },
      resume: async () => { throw new Error("not found"); },
    };
    const result = await runSubagent(fakeCtx(), { agentType: "w", prompt: "p", childDepth: 2 }, factory);
    expect(result.state).toBe("error");
    expect(result.error).toContain("spawn failed");
  });

  it("emits live progress, updates widget counters, and ignores registration hook failures", async () => {
    // Intent: structured progress drives both tool updates and registry-backed widget counters,
    // while auxiliary registration hooks must not break a successful delegation.
    const progress: Array<{ kind: string; text: string; turns?: number; toolCalls?: number }> = [];
    const registrySnapshots: Array<{ status: string; turns: number; toolCount: number }> = [];
    const stopObservingRegistry = subagentRegistry.onChange(() => {
      const node = subagentRegistry.get("child-progress");
      if (node) registrySnapshots.push({ status: node.status, turns: node.turns, toolCount: node.toolCount });
    });
    const unsubscribe = vi.fn();
    const child: SubagentSession = {
      sessionId: "child-progress",
      prompt: async () => undefined,
      collect: () => ({ report: "done", toolCount: 2 }),
      subscribe(listener) {
        listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "src/a.ts" } });
        listener({ type: "tool_execution_update", toolCallId: "call-1", toolName: "read", partialResult: { content: [{ type: "text", text: "path: src/a.ts" }] } });
        listener({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "path: src/a.ts\n1|alpha" }] } });
        listener({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "final summary" }] },
        });
        listener({ type: "ignored" });
        return unsubscribe;
      },
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    const factory: SubagentSessionFactory = { spawn: async () => child, resume: async () => child };
    const result = await runSubagent(
      fakeCtx(),
      {
        agentType: "worker",
        prompt: "go",
        childDepth: 2,
        onRegistered() {
          throw new Error("ignore me");
        },
        onProgress(update) {
          progress.push(update);
        },
      },
      factory,
    );
    stopObservingRegistry();
    expect(result).toEqual({ sessionId: "child-progress", state: "completed", report: "done" });
    expect(registrySnapshots).toContainEqual({ status: "running", turns: 1, toolCount: 1 });
    expect(progress).toEqual([
      { kind: "status", text: "started worker session child-progress" },
      { kind: "tool", text: '→ read {"path":"src/a.ts"}', toolCalls: 1 },
      { kind: "tool", text: '✓ read {"path":"src/a.ts"}' },
      { kind: "assistant", text: "assistant\nfinal summary", turns: 1 },
      { kind: "status", text: "completed" },
    ]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(child.dispose).toHaveBeenCalledTimes(1);
  });

  it("aborts a subagent that stays idle past idleTimeoutMs", async () => {
    // Intent: a delegated child that stops emitting any assistant/session activity should
    // not block the parent forever.
    vi.useFakeTimers();
    let rejectPrompt!: (error: Error) => void;
    const child: SubagentSession = {
      sessionId: "child-idle",
      prompt: () => new Promise<void>((_resolve, reject) => {
        rejectPrompt = reject;
      }),
      collect: () => ({ report: undefined, toolCount: 0 }),
      abort: vi.fn(() => rejectPrompt(new Error("watchdog abort"))),
      dispose: vi.fn(),
    };
    const factory: SubagentSessionFactory = { spawn: async () => child, resume: async () => child };
    try {
      const resultPromise = runSubagent(
        fakeCtx(),
        { agentType: "worker", prompt: "go", childDepth: 2, idleTimeoutMs: 50 },
        factory,
      );
      await vi.advanceTimersByTimeAsync(60);
      const result = await resultPromise;
      expect(result.state).toBe("error");
      expect(result.error).toContain("idle timeout after 50ms");
      expect(child.abort).toHaveBeenCalledTimes(1);
      expect(subagentRegistry.get("child-idle")?.status).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not count long-running tool execution silence toward idleTimeoutMs", async () => {
    // Intent: idle watchdog should target model/session-side stalls; once a tool
    // starts running, silence during the tool body itself should not trip idle.
    vi.useFakeTimers();
    let listener: ((event: unknown) => void) | undefined;
    let rejectPrompt!: (error: Error) => void;
    const child: SubagentSession = {
      sessionId: "child-tool-idle",
      prompt: async () => {
        listener?.({ type: "tool_execution_start", toolCallId: "call-bash", toolName: "bash", args: { command: "sleep 999" } });
        await new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        });
      },
      collect: () => ({ report: undefined, toolCount: 0 }),
      subscribe(next) {
        listener = next;
        return () => undefined;
      },
      abort: vi.fn(() => rejectPrompt(new Error("tool-finished-timeout"))),
      dispose: vi.fn(),
    };
    const factory: SubagentSessionFactory = { spawn: async () => child, resume: async () => child };
    try {
      const resultPromise = runSubagent(
        fakeCtx(),
        { agentType: "worker", prompt: "go", childDepth: 2, idleTimeoutMs: 50 },
        factory,
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(child.abort).toHaveBeenCalledTimes(0);

      listener?.({ type: "tool_execution_end", toolCallId: "call-bash", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "done" }] } });
      await vi.advanceTimersByTimeAsync(60);
      const result = await resultPromise;
      expect(child.abort).toHaveBeenCalledTimes(1);
      expect(result.state).toBe("error");
      expect(result.error).toContain("idle timeout after 50ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("steers the child once when a tool-driving turn reaches maxTurns without hard-aborting it", async () => {
    // Intent: steering is consumed before the next model turn, unlike follow-up messages which wait
    // until the child would otherwise stop. Queue it once so a looping child does not accumulate duplicates.
    const progress: string[] = [];
    let listener: ((event: unknown) => void) | undefined;
    const steer = vi.fn(async () => undefined);
    const child: SubagentSession = {
      sessionId: "child-turn-limit",
      prompt: async () => {
        listener?.({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "toolCall" }] },
        });
        listener?.({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "toolCall" }] },
        });
        listener?.({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "final answer" }] },
        });
      },
      collect: () => ({ report: "final answer", toolCount: 2 }),
      subscribe(next) {
        listener = next;
        return () => undefined;
      },
      steer,
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    const factory: SubagentSessionFactory = { spawn: async () => child, resume: async () => child };
    const result = await runSubagent(
      fakeCtx(),
      {
        agentType: "worker",
        prompt: "go",
        childDepth: 2,
        maxTurns: 1,
        onProgress(update) {
          progress.push(update.text);
        },
      },
      factory,
    );
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(expect.stringContaining("delegated task turn limit"));
    expect(child.abort).toHaveBeenCalledTimes(0);
    expect(result).toEqual({ sessionId: "child-turn-limit", state: "completed", report: "final answer" });
    expect(progress.join("\n")).toContain("turn limit reached (1/1)");
    expect(progress.join("\n")).not.toContain("turn limit reached (2/1)");
  });
});

describe("collectFromMessages", () => {
  it("returns the last assistant text and counts Pi toolCall blocks", () => {
    // Intent: report = last assistant text; toolCount must match Pi's real assistant block type (`toolCall`).
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "first" }, { type: "toolCall" }] },
      { role: "assistant", content: [{ type: "text", text: "final answer" }] },
    ];
    expect(collectFromMessages(messages)).toEqual({ report: "final answer", toolCount: 1 });
  });

  it("keeps backward compatibility with legacy tool-use block aliases", () => {
    const messages = [{ role: "assistant", content: [{ type: "tool_use" }, { type: "tool_call" }] }];
    expect(collectFromMessages(messages)).toEqual({ report: undefined, toolCount: 2 });
  });
});

describe("formatRunResult", () => {
  it("wraps a completed report and includes the session id for resume", () => {
    const xml = formatRunResult({ sessionId: "s1", state: "completed", report: "done" });
    expect(xml).toContain('id="s1"');
    expect(xml).toContain("state=\"completed\"");
    expect(xml).toContain("<task_result>\ndone\n</task_result>");
  });

  it("renders a placeholder when the completed child produced no textual report", () => {
    // Intent: callers need a stable result envelope even when the child ended silently.
    const xml = formatRunResult({ sessionId: "s1-empty", state: "completed" });
    expect(xml).toContain("(no textual report produced)");
  });

  it("emits an error envelope with the session id for failures", () => {
    const xml = formatRunResult({ sessionId: "s2", state: "error", error: "boom" });
    expect(xml).toContain('id="s2"');
    expect(xml).toContain("<task_error>boom</task_error>");
  });
});

describe("subagentSessionDir", () => {
  it("uses a hashed cwd-derived directory name to avoid lexical path collisions", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await createTempWorkspace();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      expect(subagentSessionDir("/a-b/c")).not.toBe(subagentSessionDir("/a/b-c"));
      expect(subagentSessionDir("/tmp/foo:bar")).not.toBe(subagentSessionDir("/tmp/foo/bar"));
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});
