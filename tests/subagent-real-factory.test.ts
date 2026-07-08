import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { DEPTH_ENTRY, ROOT_SESSION_ENTRY, rootSessionEntryData } from "../src/subagent/depth.js";

const mocked = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  createAgentSession: vi.fn(),
  getAgentDir: vi.fn(() => "/agent-home"),
  sessionManagerCreate: vi.fn(),
  sessionManagerOpen: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: mocked.readdirSync,
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mocked.createAgentSession,
  getAgentDir: mocked.getAgentDir,
  SessionManager: {
    create: mocked.sessionManagerCreate,
    open: mocked.sessionManagerOpen,
  },
}));

function fakeManager(sessionId = "child-session") {
  return {
    appendCustomEntry: vi.fn(),
    getSessionId: () => sessionId,
  };
}

function fakeSession(
  messages: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }> = [
    { role: "assistant", content: [{ type: "toolCall" }, { type: "text", text: "final answer" }] },
  ],
) {
  return {
    bindExtensions: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    messages,
    subscribe: vi.fn(() => () => undefined),
    abort: vi.fn(),
  };
}

function fakeCtx(
  cwd = "/work/repo",
  sessionId = "parent-session",
  entries: Array<{ type: string; customType?: string; data?: unknown }> = [],
) {
  return {
    cwd,
    model: { provider: "provider", id: "model" },
    modelRegistry: { find: vi.fn(), isUsingOAuth: vi.fn(() => false) },
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
    },
  } as any;
}

beforeEach(() => {
  mocked.readdirSync.mockReset();
  mocked.createAgentSession.mockReset();
  mocked.getAgentDir.mockClear();
  mocked.sessionManagerCreate.mockReset();
  mocked.sessionManagerOpen.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createRealSubagentFactory", () => {
  it("persists agent/depth/root metadata before spawning an isolated child session", async () => {
    // Intent: spawned children must carry enough persisted metadata for prompt
    // rebuilding, depth limits, and root-owned permission relay.
    const { createRealSubagentFactory, subagentSessionDir } = await import("../src/subagent/runner.js");
    const session = fakeSession();
    const manager = fakeManager("child-1");
    mocked.createAgentSession.mockResolvedValue({ session });
    mocked.sessionManagerCreate.mockReturnValue(manager);

    const ctx = fakeCtx("/work/repo", "parent-session", [
      { type: "custom", customType: ROOT_SESSION_ENTRY, data: rootSessionEntryData("root-7") },
    ]);
    const factory = createRealSubagentFactory();
    const child = await factory.spawn({ ctx, agentType: "worker", childDepth: 3 });

    expect(mocked.sessionManagerCreate).toHaveBeenCalledWith("/work/repo", subagentSessionDir("/work/repo"));
    expect(manager.appendCustomEntry).toHaveBeenNthCalledWith(1, "pi-base-agent-state", { name: "worker" });
    expect(manager.appendCustomEntry).toHaveBeenNthCalledWith(2, DEPTH_ENTRY, { depth: 3 });
    expect(manager.appendCustomEntry).toHaveBeenNthCalledWith(3, ROOT_SESSION_ENTRY, { rootSessionId: "root-7" });
    expect(session.bindExtensions).toHaveBeenCalledWith({});
    await child.prompt("go");
    expect(session.prompt).toHaveBeenCalledWith("go");
    await child.followUp?.("finish now");
    expect(session.followUp).toHaveBeenCalledWith("finish now");
    expect(child.collect()).toEqual({ report: "final answer", toolCount: 1 });
    child.abort();
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it("reopens matching legacy session files and refreshes the requested agent type on resume", async () => {
    // Intent: resume must support pre-hash storage layouts and append a new
    // agent-state entry so the latest agent config wins.
    const { createRealSubagentFactory, subagentSessionDir } = await import("../src/subagent/runner.js");
    const cwd = "/work/repo";
    const hashedDir = subagentSessionDir(cwd);
    const legacyDir = join("/agent-home", "subagent-sessions", "--work-repo--");
    mocked.readdirSync.mockImplementation((dir: string) => {
      if (dir === hashedDir) return ["other.jsonl"];
      if (dir === legacyDir) return ["agent_resumed-1.jsonl"];
      throw new Error(`ENOENT ${dir}`);
    });

    const session = fakeSession([{ role: "assistant", content: [{ type: "text", text: "resumed report" }] }]);
    const manager = fakeManager("resumed-1");
    mocked.createAgentSession.mockResolvedValue({ session });
    mocked.sessionManagerOpen.mockReturnValue(manager);

    const factory = createRealSubagentFactory();
    const child = await factory.resume({ ctx: fakeCtx(cwd, "parent-2"), sessionId: "resumed-1", agentType: "reviewer" });

    expect(mocked.sessionManagerOpen).toHaveBeenCalledWith(join(legacyDir, "agent_resumed-1.jsonl"));
    expect(manager.appendCustomEntry).toHaveBeenNthCalledWith(1, "pi-base-agent-state", { name: "reviewer" });
    expect(manager.appendCustomEntry).toHaveBeenNthCalledWith(2, ROOT_SESSION_ENTRY, { rootSessionId: "parent-2" });
    expect(child.collect()).toEqual({ report: "resumed report", toolCount: 0 });
  });

  it("throws a clear error when no persisted session file matches the requested id", async () => {
    // Intent: missing resume targets should fail fast with a deterministic
    // message instead of opening an arbitrary session file.
    const { createRealSubagentFactory } = await import("../src/subagent/runner.js");
    mocked.readdirSync.mockReturnValue([]);

    const factory = createRealSubagentFactory();
    await expect(factory.resume({ ctx: fakeCtx(), sessionId: "missing", agentType: "worker" })).rejects.toThrow(
      'subagent session "missing" not found',
    );
  });
});
