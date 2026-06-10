import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { executeSubagent } from "../src/task/runner.js";
import { appendSubagentInvocation, getSubagentSessionDir, openSubagentSessionManager } from "../src/task/sessions.js";
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

async function writeAgentFile(root: string, name: string, content: string): Promise<void> {
  const dir = join(root, ".pi", "subagents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), content, "utf8");
}

class FakeSession {
  public readonly sessionManager: SessionManager;
  public readonly sessionId: string;
  public readonly sessionFile?: string;
  public messages: unknown[];
  private listener: ((event: any) => void) | undefined;

  constructor(manager: SessionManager, private readonly finalText = "Done") {
    this.sessionManager = manager;
    this.sessionId = manager.getSessionId();
    this.sessionFile = manager.getSessionFile();
    this.messages = manager.buildSessionContext().messages as unknown[];
  }

  async bindExtensions(): Promise<void> {}

  subscribe(listener: (event: any) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  setSessionName(name: string): void {
    this.sessionManager.appendSessionInfo(name);
  }

  async prompt(text: string): Promise<void> {
    this.listener?.({ type: "message_start" });
    this.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }] } as any);
    this.messages = this.sessionManager.buildSessionContext().messages as unknown[];
    this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Streaming" } });
    this.listener?.({ type: "tool_execution_start", toolName: "read" });
    this.listener?.({ type: "tool_execution_end", toolName: "read" });
    this.sessionManager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: this.finalText },
        { type: "toolCall", name: "read", arguments: { path: "src/demo.ts" } },
      ],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    } as any);
    this.messages = this.sessionManager.buildSessionContext().messages as unknown[];
    this.listener?.({ type: "message_end", message: { role: "assistant" } });
    this.listener?.({ type: "turn_end" });
  }

  async abort(): Promise<void> {}

  dispose(): void {}
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("executeSubagent", () => {
  it("returns a clear error when no subagents are configured", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      const parent = SessionManager.inMemory(workspace);
      const result = await executeSubagent({
        pi: { getThinkingLevel: () => "off" },
        ctx: {
          cwd: workspace,
          sessionManager: parent as any,
          modelRegistry: {} as any,
          model: undefined,
        } as any,
        name: "reviewer",
        prompt: "Review this",
        createSession: async () => {
          throw new Error("should not create session");
        },
      });

      expect(result.isError).toBe(true);
      expect((result.content[0] as any)?.text).toContain("No subagents are configured");
    });
  });

  it("returns a clear error for unknown subagent names", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
---
Reviewer body
`);

      const parent = SessionManager.inMemory(workspace);
      const result = await executeSubagent({
        pi: { getThinkingLevel: () => "off" },
        ctx: {
          cwd: workspace,
          sessionManager: parent as any,
          modelRegistry: {} as any,
          model: undefined,
        } as any,
        name: "missing",
        prompt: "Review this",
        createSession: async () => {
          throw new Error("should not create session");
        },
      });

      expect(result.isError).toBe(true);
      expect((result.content[0] as any)?.text).toContain('unknown subagent "missing"');
      expect((result.content[0] as any)?.text).toContain("Available subagents: reviewer");
    });
  });

  it("passes the configured model and thinking level into session creation", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
model: sonnet
thinking: high
---
Reviewer body
`);

      const parent = SessionManager.create(workspace);
      const seen: { model?: any; thinkingLevel?: string } = {};
      const result = await executeSubagent({
        pi: { getThinkingLevel: () => "low" },
        ctx: {
          cwd: workspace,
          sessionManager: parent as any,
          modelRegistry: {
            getAvailable: () => [
              { provider: "anthropic", id: "claude-haiku-4", name: "haiku" },
              { provider: "anthropic", id: "claude-sonnet-4", name: "sonnet" },
            ],
            find: (provider: string, id: string) => ({ provider, id }),
          },
          model: { provider: "anthropic", id: "claude-haiku-4" },
        } as any,
        name: "reviewer",
        prompt: "Review this",
        createSession: (async (input: any) => {
          seen.model = input.model;
          seen.thinkingLevel = input.thinkingLevel;
          return { session: new FakeSession(input.sessionManager, "Configured") as any, extensionsResult: {} as any };
        }) as any,
      });

      expect(result.isError).not.toBe(true);
      expect(seen.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4" });
      expect(seen.thinkingLevel).toBe("high");
      expect((result.content[0] as any)?.text).toContain("Configured");
    });
  });
  it("reports missing model registries when a subagent pins a model", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
model: sonnet
---
Reviewer body
`);

      const result = await executeSubagent({
        pi: { getThinkingLevel: () => "off" },
        ctx: {
          cwd: workspace,
          sessionManager: SessionManager.create(workspace) as any,
          modelRegistry: {} as any,
          model: undefined,
        } as any,
        name: "reviewer",
        prompt: "Review this",
      });

      expect(result.isError).toBe(true);
      expect((result.content[0] as any)?.text).toContain("model registry");
    });
  });

  it("reports an empty available-model list for configured subagent models", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
model: sonnet
---
Reviewer body
`);

      const result = await executeSubagent({
        pi: { getThinkingLevel: () => "off" },
        ctx: {
          cwd: workspace,
          sessionManager: SessionManager.create(workspace) as any,
          modelRegistry: {
            getAvailable: () => [],
            find: () => undefined,
          },
          model: undefined,
        } as any,
        name: "reviewer",
        prompt: "Review this",
      });

      expect(result.isError).toBe(true);
      expect((result.content[0] as any)?.text).toContain("No available models are configured");
    });
  });

  it("falls back to the parent model and thinking level when not configured", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
---
Reviewer body
`);

      const parent = SessionManager.create(workspace);
      const seen: { model?: any; thinkingLevel?: string } = {};
      const result = await executeSubagent({
        pi: { getThinkingLevel: () => "medium" },
        ctx: {
          cwd: workspace,
          sessionManager: parent as any,
          modelRegistry: { getAvailable: () => [], find: () => undefined },
          model: { provider: "anthropic", id: "claude-haiku-4" },
        } as any,
        name: "reviewer",
        prompt: "Review this",
        createSession: (async (input: any) => {
          seen.model = input.model;
          seen.thinkingLevel = input.thinkingLevel;
          return { session: new FakeSession(input.sessionManager, "Inherited") as any, extensionsResult: {} as any };
        }) as any,
      });

      expect(result.isError).not.toBe(true);
      expect(seen.model).toEqual({ provider: "anthropic", id: "claude-haiku-4" });
      expect(seen.thinkingLevel).toBe("medium");
    });
  });

  it("returns a clear error for invalid configured models", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
model: opus
---
Reviewer body
`);

      const result = await executeSubagent({
        pi: { getThinkingLevel: () => "off" },
        ctx: {
          cwd: workspace,
          sessionManager: SessionManager.create(workspace) as any,
          modelRegistry: {
            getAvailable: () => [{ provider: "anthropic", id: "claude-haiku-4", name: "haiku" }],
            find: (provider: string, id: string) => ({ provider, id }),
          },
          model: undefined,
        } as any,
        name: "reviewer",
        prompt: "Review this",
      });

      expect(result.isError).toBe(true);
      expect(result.details.summary).toBe("(invalid subagent model)");
      expect((result.content[0] as any)?.text).toContain("Model not found");
    });
  });
  it("accepts exact provider/model identifiers", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
model: anthropic/claude-sonnet-4
---
Reviewer body
`);

      let seenModel: any;
      await executeSubagent({
        pi: { getThinkingLevel: () => "off" },
        ctx: {
          cwd: workspace,
          sessionManager: SessionManager.create(workspace) as any,
          modelRegistry: {
            getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4", name: "sonnet" }],
            find: (provider: string, id: string) => ({ provider, id }),
          },
          model: undefined,
        } as any,
        name: "reviewer",
        prompt: "Review this",
        createSession: (async (input: any) => {
          seenModel = input.model;
          return { session: new FakeSession(input.sessionManager, "Exact") as any, extensionsResult: {} as any };
        }) as any,
      });

      expect(seenModel).toEqual({ provider: "anthropic", id: "claude-sonnet-4" });
    });
  });

  it("accepts a non-aborted signal on successful runs", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
---
Reviewer body
`);

      const controller = new AbortController();
      const result = await executeSubagent({
        pi: { getThinkingLevel: () => "off" },
        ctx: {
          cwd: workspace,
          sessionManager: SessionManager.create(workspace) as any,
          modelRegistry: {} as any,
          model: undefined,
        } as any,
        name: "reviewer",
        prompt: "Review this",
        signal: controller.signal,
        createSession: (async (input: any) => ({ session: new FakeSession(input.sessionManager, "Signal ok") as any, extensionsResult: {} as any })) as any,
      });

      expect(result.isError).not.toBe(true);
      expect((result.content[0] as any)?.text).toContain("Signal ok");
    });
  });

  it("creates a child session, records invocations, and allows handoff to a different name on resume", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "coder", `---
name: coder
description: Coder
tools: read,grep
skills: []
---
Coder body
`);
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
---
Reviewer body
`);

      const parent = SessionManager.create(workspace);
      parent.appendMessage({ role: "user", content: [{ type: "text", text: "root" }] } as any);

      const partials: string[] = [];
      const createSession = (async (input: any) => ({ session: new FakeSession(input.sessionManager, "Child done") as any, extensionsResult: {} as any })) as any;
      const first = await executeSubagent({
        pi: { getThinkingLevel: () => "off" },
        ctx: {
          cwd: workspace,
          sessionManager: parent as any,
          modelRegistry: {} as any,
          model: undefined,
        } as any,
        name: "coder",
        prompt: "Implement this",
        onUpdate: (partial) => partials.push(partial.details.summary),
        createSession,
      });

      expect(first.isError).toBeUndefined();
      expect(first.details.status).toBe("completed");
      expect(first.details.sessionId).toBeTruthy();
      expect(partials.length).toBeGreaterThan(0);
      expect((first.content[0] as any)?.text).toContain("subagent coder run completed.");
      expect((first.content[0] as any)?.text).toContain("session_id: `");
      expect((first.content[0] as any)?.text).toContain("Child done");

      const resumed = await executeSubagent({
        pi: { getThinkingLevel: () => "off" },
        ctx: {
          cwd: workspace,
          sessionManager: parent as any,
          modelRegistry: {} as any,
          model: undefined,
        } as any,
        name: "reviewer",
        prompt: "Review the existing work",
        sessionId: first.details.sessionId,
        createSession,
      });

      expect(resumed.details.sessionId).toBe(first.details.sessionId);
      expect((resumed.content[0] as any)?.text).toContain("subagent reviewer run completed.");

      const reopened = await openSubagentSessionManager(workspace, first.details.sessionId!, agentDir);
      const customEntries = reopened.getEntries().filter((entry) => entry.type === "custom");
      expect(customEntries).toHaveLength(2);
      expect(reopened.getSessionName()).toBe("reviewer");
      expect(getSubagentSessionDir(workspace, agentDir)).toContain("sessions-subagents");
    });
  });

  it("reports startup failures before a child session is created", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
---
Reviewer body
`);

      const parent = SessionManager.create(workspace);
      const result = await executeSubagent({
        pi: { getThinkingLevel: () => "off" },
        ctx: {
          cwd: workspace,
          sessionManager: parent as any,
          modelRegistry: {} as any,
          model: undefined,
        } as any,
        name: "reviewer",
        prompt: "Review this",
        createSession: async () => {
          throw new Error("session bootstrap failed");
        },
      });

      expect(result.isError).toBe(true);
      expect((result.content[0] as any)?.text).toContain("session bootstrap failed");
      expect(result.details.summary).toBe("(subagent failed to start)");
    });
  });

  it("treats aborted assistant completions as failed subagent runs", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
---
Reviewer body
`);

      class AbortedCompletionSession extends FakeSession {
        override async prompt(text: string): Promise<void> {
          this.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }] } as any);
          this.sessionManager.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "" }],
            api: "test-api",
            provider: "test-provider",
            model: "test-model",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "aborted",
            errorMessage: "Operation aborted",
            timestamp: Date.now(),
          } as any);
          this.messages = this.sessionManager.buildSessionContext().messages as unknown[];
        }
      }

      const result = await executeSubagent({
        pi: { getThinkingLevel: () => "off" },
        ctx: {
          cwd: workspace,
          sessionManager: SessionManager.create(workspace) as any,
          modelRegistry: {} as any,
          model: undefined,
        } as any,
        name: "reviewer",
        prompt: "Review this",
        createSession: (async (input: any) => ({ session: new AbortedCompletionSession(input.sessionManager) as any, extensionsResult: {} as any })) as any,
      });

      expect(result.isError).toBe(true);
      expect(result.details.status).toBe("failed");
      expect(result.details.error).toBe("Operation aborted");
      expect((result.content[0] as any)?.text).toContain("Operation aborted");
    });
  });

  it("respects abort signals by calling session.abort() and returning a failure result", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
---
Reviewer body
`);

      let abortCalled = false;
      class AbortableSession extends FakeSession {
        override async prompt(): Promise<void> {
          await new Promise((_resolve, reject) => setTimeout(() => reject(new Error("aborted by signal")), 10));
        }
        override async abort(): Promise<void> {
          abortCalled = true;
        }
      }

      const controller = new AbortController();
      const pending = executeSubagent({
        pi: { getThinkingLevel: () => "off" },
        ctx: {
          cwd: workspace,
          sessionManager: SessionManager.create(workspace) as any,
          modelRegistry: {} as any,
          model: undefined,
        } as any,
        name: "reviewer",
        prompt: "Review this",
        signal: controller.signal,
        createSession: (async (input: any) => ({ session: new AbortableSession(input.sessionManager) as any, extensionsResult: {} as any })) as any,
      });
      controller.abort();
      const result = await pending;

      expect(abortCalled).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.details.status).toBe("failed");
    });
  });

  it("keeps invocation metadata on parent sessions for compatibility", () => {
    const manager = SessionManager.inMemory(process.cwd());
    appendSubagentInvocation(manager, { name: "coder", timestamp: "1" });
    expect(manager.getEntries().some((entry) => entry.type === "custom")).toBe(true);
  });
});
