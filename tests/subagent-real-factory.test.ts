import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPTH_ENTRY, ROOT_SESSION_ENTRY, rootSessionEntryData } from "../src/subagent/depth.js";
import { PI_BASE_MODULE_INSTANCE_MARKER, PI_BASE_MODULE_INSTANCE_TOKEN } from "../src/subagent/runner.js";

const CURRENT_PI_BASE_EXTENSION_ENTRY = resolve(fileURLToPath(new URL("../index.ts", import.meta.url)));

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
    appendModelChange: vi.fn(),
    appendThinkingLevelChange: vi.fn(),
    buildSessionContext: vi.fn(() => ({ messages: [{}] })),
    getSessionId: () => sessionId,
  };
}

function loadedExtensions(
  resolvedPath = CURRENT_PI_BASE_EXTENSION_ENTRY,
  moduleToken: object = PI_BASE_MODULE_INSTANCE_TOKEN,
) {
  return {
    extensions: [{
      resolvedPath,
      tools: new Map([["task", { definition: { [PI_BASE_MODULE_INSTANCE_MARKER]: moduleToken } }]]),
    }],
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
    steer: vi.fn(async () => undefined),
    messages,
    subscribe: vi.fn(() => () => undefined),
    abort: vi.fn(),
    extensionRunner: { emit: vi.fn(async () => undefined) },
    dispose: vi.fn(),
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
    modelRegistry: {
      find: vi.fn(),
      hasConfiguredAuth: vi.fn(() => false),
      isUsingOAuth: vi.fn(() => false),
    },
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
  it("persists agent/depth/root metadata before binding an isolated child session", async () => {
    // Intent: after extension identity is verified, children must carry enough persisted metadata
    // for prompt rebuilding, depth limits, and root-owned permission relay before session_start.
    const { createRealSubagentFactory, subagentSessionDir } = await import("../src/subagent/runner.js");
    const session = fakeSession();
    const manager = fakeManager("child-1");
    mocked.createAgentSession.mockResolvedValue({ session, extensionsResult: loadedExtensions() });
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
    expect(manager.appendCustomEntry.mock.invocationCallOrder[0]).toBeLessThan(session.bindExtensions.mock.invocationCallOrder[0]);
    expect(session.bindExtensions).toHaveBeenCalledWith({});
    expect(session.prompt).not.toHaveBeenCalled();
    await child.prompt("go");
    expect(session.prompt).toHaveBeenCalledWith("go");
    await child.steer?.("finish now");
    expect(session.steer).toHaveBeenCalledWith("finish now");
    expect(child.collect()).toEqual({ report: "final answer", toolCount: 1 });
    child.abort();
    expect(session.abort).toHaveBeenCalledTimes(1);
    await child.dispose();
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(session.dispose).toHaveBeenCalledTimes(1);
    await child.dispose();
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects a symlinked path that would load a second pi-base module instance", async () => {
    // Intent: Pi/Jiti keys its module cache by load-path string. Even when a symlink reaches this
    // checkout, accepting it would split process-local registries and permission hosts.
    const { createRealSubagentFactory } = await import("../src/subagent/runner.js");
    const root = await mkdtemp(join(tmpdir(), "pi-base-extension-identity-"));
    const checkoutLink = join(root, "pi-base-link");
    await symlink(dirname(CURRENT_PI_BASE_EXTENSION_ENTRY), checkoutLink, process.platform === "win32" ? "junction" : "dir");
    const session = fakeSession();
    const manager = fakeManager("symlinked-child");
    mocked.createAgentSession.mockResolvedValue({
      session,
      extensionsResult: loadedExtensions(join(checkoutLink, "index.ts"), {}),
    });
    mocked.sessionManagerCreate.mockReturnValue(manager);

    await expect(createRealSubagentFactory().spawn({
      ctx: fakeCtx(),
      agentType: "worker",
      childDepth: 2,
    })).rejects.toThrow(/same load path as a persistent Pi extension/);

    expect(manager.appendCustomEntry).not.toHaveBeenCalled();
    expect(session.bindExtensions).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no pi-base extension", loadedExtensions().extensions.slice(0, 0)],
    ["the same path from a reloaded module instance", loadedExtensions(CURRENT_PI_BASE_EXTENSION_ENTRY, {}).extensions],
    ["the current marker at a different load path", loadedExtensions("/old/pi-base/index.ts").extensions],
  ])("fails fast and disposes when the child loader contains %s", async (_caseName, extensions) => {
    // Intent: source-only or stale package discovery must never run a child without this exact
    // pi-base module instance, and startup failure must release the partially-created session.
    const { createRealSubagentFactory } = await import("../src/subagent/runner.js");
    const session = fakeSession();
    const manager = fakeManager("unbound-child");
    mocked.createAgentSession.mockResolvedValue({ session, extensionsResult: { extensions } });
    mocked.sessionManagerCreate.mockReturnValue(manager);

    const factory = createRealSubagentFactory();
    await expect(factory.spawn({ ctx: fakeCtx(), agentType: "worker", childDepth: 2 })).rejects.toThrow(
      /Register the same load path as a persistent Pi extension.*source-only `pi -e`/,
    );
    expect(manager.appendCustomEntry).not.toHaveBeenCalled();
    expect(session.bindExtensions).not.toHaveBeenCalled();
    expect(session.extensionRunner.emit).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not mutate a persisted session when resume fails the extension identity check", async () => {
    // Intent: fail-fast must leave resumable agent/depth/model metadata unchanged when the child
    // cannot load this pi-base checkout.
    const { createRealSubagentFactory } = await import("../src/subagent/runner.js");
    const session = fakeSession();
    const manager = fakeManager("guarded-resume");
    mocked.readdirSync.mockReturnValue(["agent_guarded-resume.jsonl"]);
    mocked.sessionManagerOpen.mockReturnValue(manager);
    mocked.createAgentSession.mockResolvedValue({ session, extensionsResult: { extensions: [] } });

    await expect(createRealSubagentFactory().resume({
      ctx: fakeCtx(),
      sessionId: "guarded-resume",
      agentType: "reviewer",
      childDepth: 4,
    })).rejects.toThrow(/Register the same load path as a persistent Pi extension/);

    expect(manager.appendCustomEntry).not.toHaveBeenCalled();
    expect(manager.appendModelChange).not.toHaveBeenCalled();
    expect(manager.appendThinkingLevelChange).not.toHaveBeenCalled();
    expect(session.bindExtensions).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("creates a new child with the target agent model and thinking level before binding", async () => {
    // Intent: a new subagent must not be initialized with the parent model and switched later.
    const { createRealSubagentFactory } = await import("../src/subagent/runner.js");
    const session = fakeSession();
    const targetModel = { provider: "target-provider", id: "target-model" };
    const ctx = fakeCtx();
    ctx.modelRegistry.find.mockReturnValue(targetModel);
    ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(true);
    mocked.createAgentSession.mockResolvedValue({ session, extensionsResult: loadedExtensions() });
    mocked.sessionManagerCreate.mockReturnValue(fakeManager("configured-child"));

    const factory = createRealSubagentFactory({
      resolveAgentRuntimeConfig: () => ({
        model: { provider: "target-provider", modelId: "target-model" },
        thinkingLevel: "high",
      }),
    });
    await factory.spawn({ ctx, agentType: "worker", childDepth: 2 });

    expect(mocked.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      model: targetModel,
      thinkingLevel: "high",
    }));
    expect(session.bindExtensions).toHaveBeenCalledWith({});
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("disposes a child session when extension binding fails", async () => {
    // Intent: a child that fails before the task handle is returned must still run extension shutdown
    // and release its AgentSession resources.
    const { createRealSubagentFactory } = await import("../src/subagent/runner.js");
    const session = fakeSession();
    session.bindExtensions.mockRejectedValueOnce(new Error("binding failed"));
    mocked.createAgentSession.mockResolvedValue({ session, extensionsResult: loadedExtensions() });
    mocked.sessionManagerCreate.mockReturnValue(fakeManager("child-failed"));

    const factory = createRealSubagentFactory();
    await expect(factory.spawn({ ctx: fakeCtx(), agentType: "worker", childDepth: 2 })).rejects.toThrow("binding failed");
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(session.dispose).toHaveBeenCalledTimes(1);
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
    const targetModel = { provider: "target-provider", id: "target-model" };
    const ctx = fakeCtx(cwd, "parent-2");
    ctx.modelRegistry.find.mockReturnValue(targetModel);
    ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(true);
    mocked.createAgentSession.mockResolvedValue({ session, extensionsResult: loadedExtensions() });
    mocked.sessionManagerOpen.mockReturnValue(manager);

    const factory = createRealSubagentFactory({
      resolveAgentRuntimeConfig: () => ({
        model: { provider: "target-provider", modelId: "target-model" },
        thinkingLevel: "high",
      }),
    });
    const child = await factory.resume({ ctx, sessionId: "resumed-1", agentType: "reviewer", childDepth: 4 });

    expect(mocked.sessionManagerOpen).toHaveBeenCalledWith(join(legacyDir, "agent_resumed-1.jsonl"));
    expect(manager.appendCustomEntry).toHaveBeenNthCalledWith(1, "pi-base-agent-state", { name: "reviewer" });
    expect(manager.appendCustomEntry).toHaveBeenNthCalledWith(2, DEPTH_ENTRY, { depth: 4 });
    expect(manager.appendModelChange).toHaveBeenCalledWith("target-provider", "target-model");
    expect(manager.appendThinkingLevelChange).toHaveBeenCalledWith("high");
    expect(manager.appendCustomEntry).toHaveBeenNthCalledWith(3, ROOT_SESSION_ENTRY, { rootSessionId: "parent-2" });
    expect(mocked.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      model: targetModel,
      thinkingLevel: "high",
    }));
    expect(session.prompt).not.toHaveBeenCalled();
    expect(child.collect()).toEqual({ report: "resumed report", toolCount: 0 });
  });

  it("throws a clear error when no persisted session file matches the requested id", async () => {
    // Intent: missing resume targets should fail fast with a deterministic
    // message instead of opening an arbitrary session file.
    const { createRealSubagentFactory } = await import("../src/subagent/runner.js");
    mocked.readdirSync.mockReturnValue([]);

    const factory = createRealSubagentFactory();
    await expect(factory.resume({ ctx: fakeCtx(), sessionId: "missing", agentType: "worker", childDepth: 2 })).rejects.toThrow(
      'subagent session "missing" not found',
    );
  });
});
