import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createAgentSession, getAgentDir, SessionManager, type AgentSessionEvent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENT_STATE_ENTRY } from "../agent-support.js";
import { DEPTH_ENTRY, ROOT_SESSION_ENTRY, readRootSessionId, rootSessionEntryData } from "./depth.js";
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
  /** Subscribe to child-session events for best-effort progress reporting. */
  subscribe?: (listener: (event: unknown) => void) => () => void;
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
  /** Called once the child session has been registered as running. */
  onRegistered?: (sessionId: string) => void;
  /** Best-effort progress line sink for live task rendering. */
  onProgress?: (line: string) => void;
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
  const rootSessionId = readRootSessionId(ctx) || parentSessionId;

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
    rootSessionId,
    agentType: args.agentType,
    description: args.description,
    depth: args.childDepth,
    status: "running",
    toolCount: 0,
    startedAt: Date.now(),
  });
  try {
    args.onRegistered?.(handle.sessionId);
  } catch {
    // Reservation/notification hooks are best-effort and must not fail the task.
  }

  args.onProgress?.(`started ${args.agentType} session ${handle.sessionId}`);
  const unsubscribeProgress = handle.subscribe?.((event) => {
    const line = formatProgressEvent(event);
    if (line) args.onProgress?.(line);
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
    unsubscribeProgress?.();
    handle.dispose();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeText(text: string, maxChars = 140): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatProgressEvent(event: unknown): string | undefined {
  if (!isRecord(event) || typeof event.type !== "string") return undefined;
  if (event.type === "tool_execution_start" && typeof event.toolName === "string") return `→ ${event.toolName}`;
  if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
    return `${event.isError === true ? "✗" : "✓"} ${event.toolName}`;
  }
  if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
    const text = summarizeText(textFromContent(event.message.content));
    return text ? `assistant: ${text}` : undefined;
  }
  return undefined;
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

function normalizeScopePath(cwd: string): string {
  return resolve(cwd).replace(/\\/g, "/");
}

function buildSubagentSessionDirName(cwd: string): string {
  const resolvedCwd = normalizeScopePath(cwd);
  const label = basename(resolvedCwd) || "root";
  const safeLabel = label.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "root";
  const hash = createHash("sha256").update(resolvedCwd).digest("hex").slice(0, 16);
  return `${safeLabel}-${hash}`;
}

function legacySubagentSessionDir(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const resolvedAgentDir = resolve(getAgentDir());
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolvedAgentDir, "subagent-sessions", safePath);
}

/** Isolated storage dir for subagent sessions, sibling to the default `sessions/` so they never
 *  pollute `/resume`. Uses a hashed cwd-derived directory name to avoid lexical path collisions. */
export function subagentSessionDir(cwd: string): string {
  const resolvedAgentDir = resolve(getAgentDir());
  return join(resolvedAgentDir, "subagent-sessions", buildSubagentSessionDirName(cwd));
}

function findSubagentSessionPath(cwd: string, sessionId: string): string | undefined {
  for (const dir of [subagentSessionDir(cwd), legacySubagentSessionDir(cwd)]) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    const match = files.find((file) => file.endsWith(`_${sessionId}.jsonl`) || file === `${sessionId}.jsonl`);
    if (match) return join(dir, match);
  }
  return undefined;
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
      if (part?.type === "toolCall" || part?.type === "tool_use" || part?.type === "tool_call") toolCount += 1;
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
      subscribe: (listener: (event: unknown) => void) => session.subscribe(listener as (event: AgentSessionEvent) => void),
      abort: () => session.abort(),
      dispose: () => undefined,
    };
  };

  return {
    async spawn({ ctx, agentType, childDepth }) {
      const sm = SessionManager.create(ctx.cwd, subagentSessionDir(ctx.cwd));
      sm.appendCustomEntry(AGENT_STATE_ENTRY, { name: agentType });
      sm.appendCustomEntry(DEPTH_ENTRY, { depth: childDepth });
      const rootSessionId = readRootSessionId(ctx);
      if (rootSessionId) sm.appendCustomEntry(ROOT_SESSION_ENTRY, rootSessionEntryData(rootSessionId));
      return build(sm, sm.getSessionId(), ctx);
    },
    async resume({ ctx, sessionId, agentType }) {
      const path = findSubagentSessionPath(ctx.cwd, sessionId);
      if (!path) throw new Error(`subagent session "${sessionId}" not found`);
      const sm = SessionManager.open(path);
      // Cross-type resume: append the requested agent so the child applies its latest config
      // (last agent-state entry wins). Same-type resume is effectively a no-op switch.
      sm.appendCustomEntry(AGENT_STATE_ENTRY, { name: agentType });
      const rootSessionId = readRootSessionId(ctx);
      if (rootSessionId) sm.appendCustomEntry(ROOT_SESSION_ENTRY, rootSessionEntryData(rootSessionId));
      return build(sm, sm.getSessionId(), ctx);
    },
  };
}
