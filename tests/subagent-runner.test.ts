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
      { agentType: "worker", description: "do work", prompt: "go", childDepth: 2 },
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
      { agentType: "worker", description: "do work", prompt: "go", childDepth: 3 },
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
    const result = await runSubagent(fakeCtx(), { agentType: "w", description: "d", prompt: "p", childDepth: 2 }, factory);
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
      { agentType: "w", description: "d", prompt: "p", childDepth: 2, signal: controller.signal },
      factory,
    );
    expect(result.state).toBe("cancelled");
    expect(child.abort).toHaveBeenCalledTimes(1);
    expect(subagentRegistry.get("child-cx")!.status).toBe("cancelled");
  });

  it("returns an error result when the session cannot even be created", async () => {
    // Intent: a factory failure (e.g. resume of a missing session) must surface as error, not throw.
    const factory: SubagentSessionFactory = {
      spawn: async () => { throw new Error("spawn failed"); },
      resume: async () => { throw new Error("not found"); },
    };
    const result = await runSubagent(fakeCtx(), { agentType: "w", description: "d", prompt: "p", childDepth: 2 }, factory);
    expect(result.state).toBe("error");
    expect(result.error).toContain("spawn failed");
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
