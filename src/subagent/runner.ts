import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAgentSession, getAgentDir, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENT_STATE_ENTRY } from "../agent-support.js";
import { DEPTH_ENTRY } from "./depth.js";
import { subagentRegistry, type SubagentStatus } from "./registry.js";

export interface RunResult {
  sessionId: string;
  state: "completed" | "error" | "cancelled";
  report?: string;
  error?: string;
}

/** A bound, runnable subagent session. Abstracted so the orchestration is unit-testable with a fake. */
export interface SubagentSession {
  sessionId: string;
  prompt: (text: string) => Promise<void>;
  /** Read the final report (last assistant text) and tool-use count after a prompt resolves. */
  collect: () => { report?: string; toolCount: number };
  abort: () => void;
  dispose: () => void;
}

export interface SubagentSessionFactory {
  spawn: (params: { ctx: ExtensionContext; agentType: string; childDepth: number }) => Promise<SubagentSession>;
  resume: (params: { ctx: ExtensionContext; sessionId: string; agentType: string }) => Promise<SubagentSession>;
}

export interface RunSubagentArgs {
  agentType: string;
  description: string;
  prompt: string;
  sessionId?: string;
  childDepth: number;
  signal?: AbortSignal;
}

/**
 * Orchestrate one foreground delegation: spawn (or resume) a subagent session, track it in the
 * registry, await completion, and collect the report. Cancellation of the parent turn (signal)
 * cascades to `session.abort()`. Always resolves with the child session id so the caller can
 * resume or inspect it, even on failure.
 */
export async function runSubagent(
  ctx: ExtensionContext,
  args: RunSubagentArgs,
  factory: SubagentSessionFactory,
): Promise<RunResult> {
  const parentSessionId = ctx.sessionManager.getSessionId();

  let handle: SubagentSession;
  try {
    handle = args.sessionId
      ? await factory.resume({ ctx, sessionId: args.sessionId, agentType: args.agentType })
      : await factory.spawn({ ctx, agentType: args.agentType, childDepth: args.childDepth });
  } catch (error) {
    return { sessionId: args.sessionId ?? "", state: "error", error: describeError(error) };
  }

  subagentRegistry.upsert({
    sessionId: handle.sessionId,
    parentSessionId,
    agentType: args.agentType,
    description: args.description,
    depth: args.childDepth,
    status: "running",
    toolCount: 0,
    startedAt: Date.now(),
  });

  const onAbort = () => handle.abort();
  args.signal?.addEventListener("abort", onAbort);
  try {
    await handle.prompt(args.prompt);
    const { report, toolCount } = handle.collect();
    finish(handle.sessionId, "done", toolCount);
    return { sessionId: handle.sessionId, state: "completed", report };
  } catch (error) {
    const cancelled = args.signal?.aborted ?? false;
    finish(handle.sessionId, cancelled ? "cancelled" : "error", safeToolCount(handle));
    return {
      sessionId: handle.sessionId,
      state: cancelled ? "cancelled" : "error",
      error: cancelled ? "aborted" : describeError(error),
    };
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
    handle.dispose();
  }
}

function finish(sessionId: string, status: SubagentStatus, toolCount: number): void {
  subagentRegistry.update(sessionId, { status, toolCount, endedAt: Date.now() });
}

function safeToolCount(handle: SubagentSession): number {
  try {
    return handle.collect().toolCount;
  } catch {
    return 0;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Format the tool result the delegating agent sees (report/error + session id for resume). */
export function formatRunResult(result: RunResult): string {
  const id = result.sessionId;
  if (result.state === "completed") {
    return `<task id="${id}" state="completed">\n<task_result>\n${result.report ?? "(no textual report produced)"}\n</task_result>\n</task>`;
  }
  return `<task id="${id}" state="${result.state}">\n<task_error>${result.error ?? result.state}</task_error>\n</task>`;
}

// ---------------------------------------------------------------------------
// Real factory: creates persistent, isolated subagent sessions in-process.
// ---------------------------------------------------------------------------

/** Isolated storage dir for subagent sessions, sibling to the default `sessions/` so they never
 *  pollute `/resume`. Mirrors pi-base's default session-dir encoding (see resume-all.ts). */
export function subagentSessionDir(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const resolvedAgentDir = resolve(getAgentDir());
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolvedAgentDir, "subagent-sessions", safePath);
}

function findSubagentSessionPath(cwd: string, sessionId: string): string | undefined {
  const dir = subagentSessionDir(cwd);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return undefined;
  }
  const match = files.find((file) => file.endsWith(`_${sessionId}.jsonl`) || file === `${sessionId}.jsonl`);
  return match ? join(dir, match) : undefined;
}

interface RuntimeMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
}

/** Extract the report (last assistant text) and tool-use count from final session messages. */
export function collectFromMessages(messages: RuntimeMessage[]): { report?: string; toolCount: number } {
  let toolCount = 0;
  let report: string | undefined;
  for (const message of messages) {
    const parts = Array.isArray(message?.content) ? message.content : [];
    for (const part of parts) {
      if (part?.type === "tool_use" || part?.type === "tool_call") toolCount += 1;
    }
    if (message?.role === "assistant") {
      const text = parts
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("")
        .trim();
      if (text) report = text;
    }
  }
  return { report, toolCount };
}

/**
 * Default factory: subagent sessions are ordinary persistent pi sessions in the isolated dir,
 * created in-process via `createAgentSession`. The child re-loads pi-base, whose `session_start`
 * applies the agent named by the pre-written `pi-base-agent-state` entry and reads its depth.
 * Sessions are headless (no uiContext) — permission prompts relay to the root via the host.
 */
export function createRealSubagentFactory(): SubagentSessionFactory {
  const build = async (sm: SessionManager, sessionId: string, ctx: ExtensionContext): Promise<SubagentSession> => {
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      sessionManager: sm,
      model: ctx.model,
      modelRegistry: ctx.modelRegistry,
    });
    await session.bindExtensions({});
    return {
      sessionId,
      prompt: (text: string) => session.prompt(text),
      collect: () => collectFromMessages(session.messages as unknown as RuntimeMessage[]),
      abort: () => session.abort(),
      dispose: () => undefined,
    };
  };

  return {
    async spawn({ ctx, agentType, childDepth }) {
      const sm = SessionManager.create(ctx.cwd, subagentSessionDir(ctx.cwd));
      sm.appendCustomEntry(AGENT_STATE_ENTRY, { name: agentType });
      sm.appendCustomEntry(DEPTH_ENTRY, { depth: childDepth });
      return build(sm, sm.getSessionId(), ctx);
    },
    async resume({ ctx, sessionId, agentType }) {
      const path = findSubagentSessionPath(ctx.cwd, sessionId);
      if (!path) throw new Error(`subagent session "${sessionId}" not found`);
      const sm = SessionManager.open(path);
      // Cross-type resume: append the requested agent so the child applies its latest config
      // (last agent-state entry wins). Same-type resume is effectively a no-op switch.
      sm.appendCustomEntry(AGENT_STATE_ENTRY, { name: agentType });
      return build(sm, sm.getSessionId(), ctx);
    },
  };
}
