import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSessionContext,
  createAgentSession,
  getAgentDir,
  migrateSessionEntries,
  parseSessionEntries,
  SessionManager,
  type AgentSession,
  type SessionEntry,
  type SessionHeader,
  type AgentSessionEvent,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { AGENT_STATE_ENTRY, type AgentRuntimeConfig } from "../agent-support.js";
import { TASK_TOOL_NAME } from "./constants.js";
import { DEPTH_ENTRY, ROOT_SESSION_ENTRY, readRootSessionId, rootSessionEntryData } from "./depth.js";
import { subagentRegistry, type SubagentStatus } from "./registry.js";

/** Marks tools registered by this exact in-process pi-base module instance. */
export const PI_BASE_MODULE_INSTANCE_MARKER = Symbol.for("pi-base.module-instance");
export const PI_BASE_MODULE_INSTANCE_TOKEN = Object.freeze({});

export interface RunResult {
  sessionId: string;
  state: "completed" | "error" | "cancelled";
  report?: string;
  error?: string;
}

/** A bound, runnable subagent session. Abstracted so the orchestration is unit-testable with a fake. */
type MessageEvent = Extract<AgentSessionEvent, { type: "message_start" }>;
type ToolUpdateEvent = Extract<AgentSessionEvent, { type: "tool_execution_update" }>;
export type SubagentViewMessage = MessageEvent["message"];
export type SubagentAssistantMessage = Extract<SubagentViewMessage, { role: "assistant" }>;

export interface SubagentViewModel {
  provider: string;
  modelId: string;
}

export interface SubagentActiveTool {
  toolCallId: string;
  toolName: string;
  args: unknown;
  executionStarted: boolean;
  argsComplete: boolean;
  partialResult?: ToolUpdateEvent["partialResult"];
}

/** Read-only access used by the interactive subagent transcript panel. */
export interface SubagentViewSource {
  cwd: string;
  agentType?: string;
  status?: string;
  turns?: number;
  toolCount?: number;
  getModel?: () => SubagentViewModel | undefined;
  getMessages: () => readonly SubagentViewMessage[];
  getStreamingMessage: () => SubagentAssistantMessage | undefined;
  getActiveTools: () => readonly SubagentActiveTool[];
  getToolDefinition: (name: string) => ToolDefinition | undefined;
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
}

export interface SubagentSession {
  sessionId: string;
  prompt: (text: string) => Promise<void>;
  /** Read the final report (last assistant text) and tool-use count after a prompt resolves. */
  collect: () => { report?: string; toolCount: number };
  /** Subscribe to child-session events for best-effort progress reporting. */
  subscribe?: (listener: (event: unknown) => void) => () => void;
  /** Optional read-only source for the interactive transcript panel. */
  view?: SubagentViewSource;
  /** Inject a steering message after the current assistant turn. Used for soft stop nudges. */
  steer?: (text: string) => Promise<void>;
  /** Abort the child session. Implementations may complete synchronously or asynchronously. */
  abort: () => void | Promise<void>;
  dispose: () => void | Promise<void>;
}

export interface SubagentSessionFactory {
  spawn: (params: { ctx: ExtensionContext; agentType: string; childDepth: number }) => Promise<SubagentSession>;
  resume: (params: { ctx: ExtensionContext; sessionId: string; agentType: string; childDepth: number }) => Promise<SubagentSession>;
}

export interface SubagentProgressUpdate {
  kind: "status" | "tool" | "assistant";
  text: string;
  turns?: number;
  toolCalls?: number;
}

export interface RunSubagentArgs {
  agentType: string;
  prompt: string;
  sessionId?: string;
  childDepth: number;
  idleTimeoutMs?: number;
  maxTurns?: number;
  signal?: AbortSignal;
  /** Called once the child session has been registered as running. */
  onRegistered?: (sessionId: string) => void;
  /** Best-effort progress sink for live task rendering. */
  onProgress?: (update: SubagentProgressUpdate) => void;
}

const MAX_TURNS_FINISH_PROMPT = readFileSync(
  new URL("../../prompts/subagent-max-turns.md", import.meta.url),
  "utf8",
).trim();
const MAX_TURNS_REMINDER_INTERVAL = 5;

function formatDurationMs(value: number): string {
  if (value < 1000) return `${value}ms`;
  const seconds = value / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

const liveHandles = new Map<string, SubagentSession>();

export function getLiveSubagentView(sessionId: string): SubagentViewSource | undefined {
  return liveHandles.get(sessionId)?.view;
}

interface PersistedSubagentSession {
  sessionId: string;
  cwd: string;
  entries: SessionEntry[];
}

export type PersistedSubagentViewResult =
  | { sessionId: string; source: SubagentViewSource }
  | "ambiguous";

function readPersistedSubagentSession(path: string): PersistedSubagentSession | undefined {
  try {
    const fileEntries = parseSessionEntries(readFileSync(path, "utf8")) as Array<SessionHeader | SessionEntry>;
    if (fileEntries.length === 0) return undefined;
    migrateSessionEntries(fileEntries);
    const header = fileEntries.find((entry): entry is SessionHeader => entry.type === "session");
    if (!header) return undefined;
    const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
    return { sessionId: header.id, cwd: header.cwd, entries };
  } catch {
    return undefined;
  }
}

function resolvePersistedSubagentSession(cwd: string, query: string): PersistedSubagentSession | "ambiguous" | undefined {
  const matches = new Map<string, PersistedSubagentSession>();
  for (const dir of [subagentSessionDir(cwd), legacySubagentSessionDir(cwd)]) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const record = readPersistedSubagentSession(join(dir, file));
      if (!record) continue;
      if (!matches.has(record.sessionId)) matches.set(record.sessionId, record);
    }
  }
  const exact = matches.get(query);
  if (exact) return exact;
  const prefixed = [...matches.values()].filter((record) => record.sessionId.startsWith(query));
  if (prefixed.length === 0) return undefined;
  return prefixed.length === 1 ? prefixed[0] : "ambiguous";
}

function assistantTurnCount(messages: RuntimeMessage[]): number {
  let turns = 0;
  for (const message of messages) {
    if (isCountedAssistantMessage(message)) turns += 1;
  }
  return turns;
}

function readPersistedAgentType(entries: SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== AGENT_STATE_ENTRY || !isRecord(entry.data)) continue;
    const name = entry.data.name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return undefined;
}

function readPersistedStatus(messages: RuntimeMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") return "error";
    if (message.stopReason === "aborted") return "cancelled";
    break;
  }
  return "done";
}

function readPersistedModel(
  messages: RuntimeMessage[],
  fallback: SubagentViewModel | null,
): SubagentViewModel | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (typeof message.provider === "string" && typeof message.model === "string") {
      return { provider: message.provider, modelId: message.model };
    }
  }
  return fallback ?? undefined;
}

export function getPersistedSubagentView(cwd: string, query: string): PersistedSubagentViewResult | undefined {
  const record = resolvePersistedSubagentSession(cwd, query);
  if (!record) return undefined;
  if (record === "ambiguous") return "ambiguous";
  const context = buildSessionContext(record.entries);
  const messages = context.messages as RuntimeMessage[];
  const model = readPersistedModel(messages, context.model);
  const { toolCount } = collectFromMessages(messages);
  return {
    sessionId: record.sessionId,
    source: {
      cwd: record.cwd,
      agentType: readPersistedAgentType(record.entries),
      status: readPersistedStatus(messages),
      turns: assistantTurnCount(messages),
      toolCount,
      getModel: () => model,
      getMessages: () => context.messages as SubagentViewMessage[],
      getStreamingMessage: () => undefined,
      getActiveTools: () => [],
      getToolDefinition: () => undefined,
      subscribe: () => () => undefined,
    },
  };
}

function subtreeSessionIds(rootSessionId: string): string[] {
  const nodes = subagentRegistry.all();
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    const bucket = childrenByParent.get(node.parentSessionId);
    if (bucket) bucket.push(node.sessionId);
    else childrenByParent.set(node.parentSessionId, [node.sessionId]);
  }
  const ordered: string[] = [];
  const queue = [rootSessionId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    ordered.push(current);
    const children = childrenByParent.get(current) ?? [];
    queue.push(...children);
  }
  return ordered;
}

async function abortSubagentTree(rootSessionId: string): Promise<void> {
  const ids = subtreeSessionIds(rootSessionId);
  await Promise.allSettled(ids.map(async (sessionId) => {
    const handle = liveHandles.get(sessionId);
    if (!handle) return;
    await handle.abort();
  }));
}

function cancelledByUserMessage(sessionId: string): string {
  return `Cancelled by user. Session preserved as \`${sessionId}\`; resume later with \`session_id: "${sessionId}"\`.`;
}

function waitForSubagentSession(promise: Promise<SubagentSession>, signal: AbortSignal | undefined): Promise<SubagentSession> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Operation aborted"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new Error("Operation aborted")));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (session) => finish(() => resolve(session)),
      (error) => finish(() => reject(error)),
    );
  });
}

function disposeLateSubagentSession(promise: Promise<SubagentSession>): void {
  void promise.then(async (session) => {
    try {
      await session.dispose();
    } catch {
      // The caller has already been released; late-session cleanup is best-effort.
    }
  }, () => undefined);
}

/**
 * Orchestrate one foreground delegation: spawn (or resume) a subagent session, track it in the
 * registry, await completion, and collect the report. Cancellation of the parent turn (signal)
 * fans out to the whole live subagent subtree rooted at this child. Returns the child session id
 * whenever one was created or provided so the caller can resume or inspect it after failure.
 */
export async function runSubagent(
  ctx: ExtensionContext,
  args: RunSubagentArgs,
  factory: SubagentSessionFactory,
): Promise<RunResult> {
  if (args.signal?.aborted) {
    const sessionId = args.sessionId ?? "";
    return {
      sessionId,
      state: "cancelled",
      error: sessionId
        ? cancelledByUserMessage(sessionId)
        : "Cancelled by user before subagent session started.",
    };
  }

  const parentSessionId = ctx.sessionManager.getSessionId();
  const rootSessionId = readRootSessionId(ctx) || parentSessionId;
  let handle: SubagentSession;
  let sessionPromise: Promise<SubagentSession> | undefined;
  try {
    sessionPromise = args.sessionId
      ? Promise.resolve(factory.resume({ ctx, sessionId: args.sessionId, agentType: args.agentType, childDepth: args.childDepth }))
      : Promise.resolve(factory.spawn({ ctx, agentType: args.agentType, childDepth: args.childDepth }));
    handle = await waitForSubagentSession(sessionPromise, args.signal);
  } catch (error) {
    if (args.signal?.aborted) {
      if (sessionPromise) disposeLateSubagentSession(sessionPromise);
      const sessionId = args.sessionId ?? "";
      return {
        sessionId,
        state: "cancelled",
        error: sessionId
          ? cancelledByUserMessage(sessionId)
          : "Cancelled by user before subagent session started.",
      };
    }
    return { sessionId: args.sessionId ?? "", state: "error", error: describeError(error) };
  }

  subagentRegistry.upsert({
    sessionId: handle.sessionId,
    parentSessionId,
    rootSessionId,
    agentType: args.agentType,
    depth: args.childDepth,
    status: "running",
    turns: 0,
    toolCount: 0,
    startedAt: Date.now(),
  });
  liveHandles.set(handle.sessionId, handle);
  try {
    args.onRegistered?.(handle.sessionId);
  } catch {
    // Reservation/notification hooks are best-effort and must not fail the task.
  }

  let idleTimedOut = false;
  let assistantTurns = 0;
  let toolCalls = 0;
  let activeToolCalls = 0;
  let lastFinishReminderTurn: number | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let cancellationRequested = false;
  const publishProgress = (update: SubagentProgressUpdate): void => {
    const lastActivity = update.kind !== "assistant" ? update.text.replace(/\s+/g, " ").trim() : "";
    if (update.turns || update.toolCalls || lastActivity) {
      subagentRegistry.update(handle.sessionId, {
        turns: assistantTurns,
        toolCount: toolCalls,
        ...(lastActivity ? { lastActivity } : {}),
      });
    }
    args.onProgress?.(update);
  };
  const clearIdleTimer = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const resetIdleTimer = () => {
    clearIdleTimer();
    if (activeToolCalls > 0) return;
    if (args.idleTimeoutMs === undefined || args.idleTimeoutMs < 1) return;
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      publishProgress({
        kind: "status",
        text: `idle timeout after ${formatDurationMs(args.idleTimeoutMs ?? 0)} without assistant/session progress; aborting`,
      });
      try {
        void Promise.resolve(handle.abort()).catch(() => undefined);
      } catch {
        // The watchdog has already recorded the timeout; abort cleanup is best-effort.
      }
    }, args.idleTimeoutMs);
    idleTimer.unref?.();
  };
  const maybeQueueFinishReminder = (assistantToolCalls: number) => {
    if (assistantToolCalls < 1) return;
    if (typeof handle.steer !== "function") return;
    if (args.maxTurns === undefined || args.maxTurns < 1) return;
    const turnsPastLimit = assistantTurns - args.maxTurns;
    if (turnsPastLimit < 0 || turnsPastLimit % MAX_TURNS_REMINDER_INTERVAL !== 0) return;
    if (lastFinishReminderTurn === assistantTurns) return;
    lastFinishReminderTurn = assistantTurns;
    const repeated = turnsPastLimit > 0;
    publishProgress({
      kind: "status",
      text: repeated
        ? `turn limit still exceeded (${assistantTurns}/${args.maxTurns}); asking subagent to finish again`
        : `turn limit reached (${assistantTurns}/${args.maxTurns}); asking subagent to finish`,
    });
    try {
      const repeatContext = repeated
        ? `\n\nThis is a repeated reminder. You are ${turnsPastLimit} successful assistant turns past the limit (${assistantTurns}/${args.maxTurns}). Return your final response now.`
        : "";
      void Promise.resolve(handle.steer(`${MAX_TURNS_FINISH_PROMPT}${repeatContext}`)).catch(() => undefined);
    } catch {
      // The finish reminder is advisory; steering failures must not replace the child report.
    }
  };

  publishProgress({ kind: "status", text: `started ${args.agentType} session ${handle.sessionId}` });
  const activeToolArgs = new Map<string, string>();
  const unsubscribeProgress = handle.subscribe?.((event) => {
    if (isToolExecutionStartEvent(event)) activeToolCalls += 1;
    else if (isToolExecutionEndEvent(event)) activeToolCalls = Math.max(0, activeToolCalls - 1);
    resetIdleTimer();
    const update = formatProgressEvent(event, activeToolArgs);
    if (update?.turns) assistantTurns += update.turns;
    if (update?.toolCalls) toolCalls += update.toolCalls;
    if (update) publishProgress(update);
    const assistantToolCalls = assistantToolCallCountFromEvent(event);
    maybeQueueFinishReminder(assistantToolCalls);
  });
  const requestCancellation = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    clearIdleTimer();
    publishProgress({ kind: "status", text: "cancel requested by user; aborting active subagent tree" });
    void abortSubagentTree(handle.sessionId);
  };
  const onAbort = () => {
    requestCancellation();
  };
  args.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (args.signal?.aborted) {
      requestCancellation();
      const failure = cancelledByUserMessage(handle.sessionId);
      publishProgress({ kind: "status", text: "cancelled" });
      finish(handle.sessionId, "cancelled", safeToolCount(handle));
      return {
        sessionId: handle.sessionId,
        state: "cancelled",
        error: failure,
      };
    }
    resetIdleTimer();
    await handle.prompt(args.prompt);
    clearIdleTimer();
    if (args.signal?.aborted) {
      const failure = cancelledByUserMessage(handle.sessionId);
      publishProgress({ kind: "status", text: "cancelled" });
      finish(handle.sessionId, "cancelled", safeToolCount(handle));
      return {
        sessionId: handle.sessionId,
        state: "cancelled",
        error: failure,
      };
    }
    if (idleTimedOut) throw new Error("idle timeout watchdog triggered");
    const { report, toolCount } = handle.collect();
    publishProgress({ kind: "status", text: "completed" });
    finish(handle.sessionId, "done", toolCount);
    return { sessionId: handle.sessionId, state: "completed", report };
  } catch (error) {
    clearIdleTimer();
    const cancelled = args.signal?.aborted ?? false;
    const failure = idleTimedOut
      ? `idle timeout after ${formatDurationMs(args.idleTimeoutMs ?? 0)} without assistant/session progress`
      : cancelled
        ? cancelledByUserMessage(handle.sessionId)
        : describeError(error);
    if (!idleTimedOut) {
      publishProgress({ kind: "status", text: cancelled ? "cancelled" : `error: ${failure}` });
    }
    finish(handle.sessionId, cancelled ? "cancelled" : "error", safeToolCount(handle));
    return {
      sessionId: handle.sessionId,
      state: cancelled ? "cancelled" : "error",
      error: failure,
    };
  } finally {
    clearIdleTimer();
    args.signal?.removeEventListener("abort", onAbort);
    unsubscribeProgress?.();
    liveHandles.delete(handle.sessionId);
    await Promise.resolve(handle.dispose()).catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCountedAssistantMessage(message: unknown): boolean {
  return isRecord(message)
    && message.role === "assistant"
    && message.stopReason !== "error"
    && message.stopReason !== "aborted";
}

function rawTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function toolCallCountFromContent(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const part of content) {
    if (part?.type === "toolCall" || part?.type === "tool_use" || part?.type === "tool_call") count += 1;
  }
  return count;
}

function assistantToolCallCountFromEvent(event: unknown): number {
  if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message) || !isCountedAssistantMessage(event.message)) return 0;
  return toolCallCountFromContent(event.message.content);
}

function isToolExecutionStartEvent(event: unknown): boolean {
  return isRecord(event) && event.type === "tool_execution_start" && typeof event.toolName === "string";
}

function isToolExecutionEndEvent(event: unknown): boolean {
  return isRecord(event) && event.type === "tool_execution_end" && typeof event.toolName === "string";
}

function summarizeText(text: string, maxChars = 140): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function stringifyPreview(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string") return serialized;
  } catch {
    // Fall back to a plain string preview for unusual event payloads.
  }
  return String(value ?? "");
}

function truncateMultiline(text: string, maxLines = 8, maxChars = 1200): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  const lines = normalized.split("\n");
  const visible: string[] = [];
  let usedChars = 0;
  for (const line of lines) {
    const nextChars = line.length + (visible.length > 0 ? 1 : 0);
    if (visible.length >= maxLines || usedChars + nextChars > maxChars) break;
    visible.push(line);
    usedChars += nextChars;
  }
  const body = visible.join("\n");
  if (body.length === normalized.length && visible.length === lines.length) return body;
  const remainingLines = Math.max(0, lines.length - visible.length);
  const suffix = remainingLines > 0 ? `${remainingLines} more lines` : "truncated";
  return `${body}\n… (${suffix})`;
}

function formatToolArgsPreview(args: unknown): string {
  if (args === undefined) return "";
  const serialized = stringifyPreview(args).trim();
  if (!serialized || serialized === "{}") return "";
  return ` ${summarizeText(serialized, 160)}`;
}

function formatProgressEvent(event: unknown, activeToolArgs: Map<string, string>): SubagentProgressUpdate | undefined {
  if (!isRecord(event) || typeof event.type !== "string") return undefined;
  if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const argsPreview = formatToolArgsPreview(event.args);
    if (toolCallId) activeToolArgs.set(toolCallId, argsPreview);
    return { kind: "tool", text: `→ ${event.toolName}${argsPreview}`, toolCalls: 1 };
  }
  if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const argsPreview = toolCallId ? (activeToolArgs.get(toolCallId) ?? "") : "";
    if (toolCallId) activeToolArgs.delete(toolCallId);
    const prefix = event.isError === true ? "✗" : "✓";
    return { kind: "tool", text: `${prefix} ${event.toolName}${argsPreview}` };
  }
  if (event.type === "message_end" && isRecord(event.message) && isCountedAssistantMessage(event.message)) {
    const body = truncateMultiline(rawTextFromContent(event.message.content));
    return { kind: "assistant", text: body ? `assistant\n${body}` : "", turns: 1 };
  }
  if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
    const body = truncateMultiline(rawTextFromContent(event.message.content));
    return { kind: "assistant", text: body ? `assistant\n${body}` : "" };
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
  provider?: string;
  model?: string;
  stopReason?: string;
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

function createLiveViewSource(session: AgentSession, cwd: string): { source: SubagentViewSource; dispose: () => void } {
  let streamingMessage: SubagentAssistantMessage | undefined;
  const activeTools = new Map<string, SubagentActiveTool>();
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      streamingMessage = event.message;
      return;
    }
    if (event.type === "message_update" && event.message.role === "assistant") {
      streamingMessage = event.message;
      for (const content of event.message.content) {
        if (content.type !== "toolCall") continue;
        const existing = activeTools.get(content.id);
        activeTools.set(content.id, {
          toolCallId: content.id,
          toolName: content.name,
          args: content.arguments,
          executionStarted: existing?.executionStarted ?? false,
          argsComplete: existing?.argsComplete ?? false,
          ...(existing?.partialResult === undefined ? {} : { partialResult: existing.partialResult }),
        });
      }
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      streamingMessage = undefined;
      for (const content of event.message.content) {
        if (content.type !== "toolCall") continue;
        const existing = activeTools.get(content.id);
        if (existing) activeTools.set(content.id, { ...existing, args: content.arguments, argsComplete: true });
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      const existing = activeTools.get(event.toolCallId);
      activeTools.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        executionStarted: true,
        argsComplete: existing?.argsComplete ?? true,
        ...(existing?.partialResult === undefined ? {} : { partialResult: existing.partialResult }),
      });
      return;
    }
    if (event.type === "tool_execution_update") {
      const existing = activeTools.get(event.toolCallId);
      activeTools.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        executionStarted: true,
        argsComplete: existing?.argsComplete ?? true,
        partialResult: event.partialResult,
      });
      return;
    }
    if (event.type === "tool_execution_end") activeTools.delete(event.toolCallId);
  });

  return {
    source: {
      cwd,
      getModel: () => {
        if (streamingMessage) {
          const streamingModel = readPersistedModel([streamingMessage as RuntimeMessage], null);
          if (streamingModel) return streamingModel;
        }
        const selectedModel = session.model;
        const fallback = selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.id } : null;
        return readPersistedModel(session.messages as unknown as RuntimeMessage[], fallback);
      },
      getMessages: () => session.messages as SubagentViewMessage[],
      getStreamingMessage: () => streamingMessage,
      getActiveTools: () => [...activeTools.values()].map((tool) => ({ ...tool })),
      getToolDefinition: (name) => session.getToolDefinition(name),
      subscribe: (listener) => session.subscribe(listener),
    },
    dispose: unsubscribe,
  };
}

export interface RealSubagentFactoryOptions {
  resolveAgentRuntimeConfig?: (agentType: string) => AgentRuntimeConfig | undefined;
}

type ResolvedAgentRuntime = {
  model: ExtensionContext["model"];
  thinkingLevel?: AgentRuntimeConfig["thinkingLevel"];
  configuredModel?: { provider: string; modelId: string };
};

function resolveAgentRuntime(
  ctx: ExtensionContext,
  agentType: string,
  options: RealSubagentFactoryOptions,
): ResolvedAgentRuntime {
  const config = options.resolveAgentRuntimeConfig?.(agentType);
  if (!config) return { model: ctx.model };

  let model = ctx.model;
  let configuredModel: ResolvedAgentRuntime["configuredModel"];
  if (config.model) {
    const candidate = ctx.modelRegistry.find(config.model.provider, config.model.modelId);
    if (candidate && ctx.modelRegistry.hasConfiguredAuth(candidate)) {
      model = candidate;
      configuredModel = { provider: candidate.provider, modelId: candidate.id };
    } else {
      console.warn(
        `Agent "${agentType}": model ${config.model.provider}/${config.model.modelId} is unavailable or has no configured auth. Subagent will keep the parent model.`,
      );
    }
  }

  const canApplyThinkingLevel = config.model === undefined || configuredModel !== undefined;
  return {
    model,
    ...(canApplyThinkingLevel && config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
    ...(configuredModel ? { configuredModel } : {}),
  };
}

const CURRENT_PI_BASE_EXTENSION_ENTRY = resolve(fileURLToPath(new URL("../../index.ts", import.meta.url)));

type LoadedExtensionIdentity = {
  resolvedPath: string;
  tools?: { get: (name: string) => { definition?: unknown } | undefined };
};

function hasCurrentPiBaseExtension(extensionsResult: { extensions: LoadedExtensionIdentity[] }): boolean {
  // Path equality is insufficient: Pi/Jiti can reload the same file into a second module instance
  // after cache invalidation or through a symlink. The task-tool marker proves that child and parent
  // share the process-local registries and permission hosts owned by this exact module instance.
  return extensionsResult.extensions.some((extension) => {
    if (resolve(extension.resolvedPath) !== CURRENT_PI_BASE_EXTENSION_ENTRY) return false;
    const definition = extension.tools?.get(TASK_TOOL_NAME)?.definition as Record<PropertyKey, unknown> | undefined;
    return definition?.[PI_BASE_MODULE_INSTANCE_MARKER] === PI_BASE_MODULE_INSTANCE_TOKEN;
  });
}

function missingCurrentPiBaseExtensionError(): Error {
  return new Error(
    `Cannot start the subagent because its resource loader did not reuse this pi-base module instance (${CURRENT_PI_BASE_EXTENSION_ENTRY}). `
      + "Register the same load path as a persistent Pi extension (normally by installing it as a Pi package); source-only `pi -e` loading is not inherited by child sessions. If that path is already configured, reload or restart the parent session so both sessions share one module instance.",
  );
}

/**
 * Default factory: subagent sessions are ordinary persistent pi sessions in the isolated dir,
 * created in-process via `createAgentSession`. The target agent's model/thinking configuration is
 * resolved before creation; persisted agent-state activates its system prompt and tools during
 * extension binding. Sessions are headless (no uiContext) — permission prompts relay to the root.
 */
export function createRealSubagentFactory(options: RealSubagentFactoryOptions = {}): SubagentSessionFactory {
  const build = async (
    sm: SessionManager,
    sessionId: string,
    ctx: ExtensionContext,
    runtime: ResolvedAgentRuntime,
    prepareSession: () => void,
  ): Promise<SubagentSession> => {
    const { session, extensionsResult } = await createAgentSession({
      cwd: ctx.cwd,
      sessionManager: sm,
      model: runtime.model,
      thinkingLevel: runtime.thinkingLevel,
      modelRegistry: ctx.modelRegistry,
    });
    const liveView = createLiveViewSource(session, ctx.cwd);
    let disposed = false;
    let extensionBindingStarted = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      try {
        if (extensionBindingStarted) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        liveView.dispose();
        session.dispose();
      }
    };
    try {
      if (!hasCurrentPiBaseExtension(extensionsResult)) throw missingCurrentPiBaseExtensionError();
      prepareSession();
      extensionBindingStarted = true;
      await session.bindExtensions({});
    } catch (error) {
      await dispose().catch(() => undefined);
      throw error;
    }
    return {
      sessionId,
      prompt: (text: string) => session.prompt(text),
      collect: () => collectFromMessages(session.messages as unknown as RuntimeMessage[]),
      subscribe: (listener: (event: unknown) => void) => liveView.source.subscribe(listener),
      view: liveView.source,
      steer: (text: string) => session.steer(text),
      abort: () => session.abort(),
      dispose,
    };
  };

  return {
    async spawn({ ctx, agentType, childDepth }) {
      const runtime = resolveAgentRuntime(ctx, agentType, options);
      const sm = SessionManager.create(ctx.cwd, subagentSessionDir(ctx.cwd));
      return build(sm, sm.getSessionId(), ctx, runtime, () => {
        sm.appendCustomEntry(AGENT_STATE_ENTRY, { name: agentType });
        sm.appendCustomEntry(DEPTH_ENTRY, { depth: childDepth });
        const rootSessionId = readRootSessionId(ctx);
        if (rootSessionId) sm.appendCustomEntry(ROOT_SESSION_ENTRY, rootSessionEntryData(rootSessionId));
      });
    },
    async resume({ ctx, sessionId, agentType, childDepth }) {
      const runtime = resolveAgentRuntime(ctx, agentType, options);
      const path = findSubagentSessionPath(ctx.cwd, sessionId);
      if (!path) throw new Error(`subagent session "${sessionId}" not found`);
      const sm = SessionManager.open(path);
      const hasExistingMessages = sm.buildSessionContext().messages.length > 0;
      return build(sm, sm.getSessionId(), ctx, runtime, () => {
        // Last agent-state/depth/model/thinking entries win when resuming in a new delegation layer.
        sm.appendCustomEntry(AGENT_STATE_ENTRY, { name: agentType });
        sm.appendCustomEntry(DEPTH_ENTRY, { depth: childDepth });
        if (hasExistingMessages && runtime.configuredModel) {
          sm.appendModelChange(runtime.configuredModel.provider, runtime.configuredModel.modelId);
        }
        if (hasExistingMessages && runtime.thinkingLevel) sm.appendThinkingLevelChange(runtime.thinkingLevel);
        const rootSessionId = readRootSessionId(ctx);
        if (rootSessionId) sm.appendCustomEntry(ROOT_SESSION_ENTRY, rootSessionEntryData(rootSessionId));
      });
    },
  };
}
