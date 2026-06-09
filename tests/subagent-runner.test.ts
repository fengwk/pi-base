import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assertSubagentAllowed, executeSubagent } from "../src/subagent/runner.js";
import { appendSubagentInvocation, getSubagentSessionDir, openSubagentSessionManager } from "../src/subagent/sessions.js";
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
  const dir = join(root, ".pi", "agents");
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
subagents: []
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
  it("allows direct helper checks for allowed and unknown callers", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
subagents: []
---
Reviewer body
`);
      await writeAgentFile(workspace, "caller", `---
name: caller
description: Caller
tools: read
skills: []
subagents: reviewer
---
Caller body
`);

      const registry = new Map<string, any>([
        ["reviewer", { name: "reviewer", description: "Reviewer", tools: ["read"], skills: [], subagents: [], body: "Reviewer body", filePath: "reviewer.md", source: "project" }],
        ["caller", { name: "caller", description: "Caller", tools: ["read"], skills: [], subagents: ["reviewer"], body: "Caller body", filePath: "caller.md", source: "project" }],
      ]);
      const noCaller = SessionManager.inMemory(workspace);
      expect(() => assertSubagentAllowed({ sessionManager: noCaller } as any, registry as any, "reviewer")).not.toThrow();
      const unknownCaller = SessionManager.inMemory(workspace);
      appendSubagentInvocation(unknownCaller, { name: "missing", timestamp: "1" });
      expect(() => assertSubagentAllowed({ sessionManager: unknownCaller } as any, registry as any, "reviewer")).not.toThrow();
      const allowedCaller = SessionManager.inMemory(workspace);
      appendSubagentInvocation(allowedCaller, { name: "caller", timestamp: "1" });
      expect(() => assertSubagentAllowed({ sessionManager: allowedCaller } as any, registry as any, "reviewer")).not.toThrow();
    });
  });

  it("enforces the caller subagent allowlist using the latest invocation", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "coder", `---
name: coder
description: Coder
tools: read
skills: []
subagents: reviewer
---
Coder body
`);
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
subagents: []
---
Reviewer body
`);
      await writeAgentFile(workspace, "planner", `---
name: planner
description: Planner
tools: read
skills: []
subagents: []
---
Planner body
`);

      const parent = SessionManager.inMemory(workspace);
      appendSubagentInvocation(parent, { name: "coder", timestamp: "1" });
      const result = await executeSubagent({
        pi: { getThinkingLevel: () => "off" },
        ctx: {
          cwd: workspace,
          sessionManager: parent as any,
          modelRegistry: {} as any,
          model: undefined,
        } as any,
        name: "planner",
        prompt: "Plan this",
        createSession: async () => {
          throw new Error("should not create session");
        },
      });

      expect(result.isError).toBe(true);
      expect((result.content[0] as any)?.text).toContain('Subagent "coder" is not allowed to invoke "planner"');
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
subagents: []
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
subagents: reviewer
---
Coder body
`);
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
subagents: []
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
      expect((first.content[0] as any)?.text).toContain("session_id:");
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
      expect((resumed.content[0] as any)?.text).toContain("name: reviewer");

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
subagents: []
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

  it("respects abort signals by calling session.abort() and returning a failure result", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
subagents: []
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
  it("treats pre-aborted signals as failures and still records the running session state", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      await writeAgentFile(workspace, "reviewer", `---
name: reviewer
description: Reviewer
tools: read
skills: []
subagents: []
---
Reviewer body
`);

      let abortCalled = false;
      class ImmediateAbortSession extends FakeSession {
        override async prompt(): Promise<void> {
          throw new Error("aborted before prompt");
        }
        override async abort(): Promise<void> {
          abortCalled = true;
        }
      }

      const controller = new AbortController();
      controller.abort();
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
        createSession: (async (input: any) => ({ session: new ImmediateAbortSession(input.sessionManager) as any, extensionsResult: {} as any })) as any,
      });

      expect(abortCalled).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.details.status).toBe("failed");
    });
  });
});
