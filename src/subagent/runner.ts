import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
type MessageEvent = Extract<AgentSessionEvent, { type: "message_start" }>;
type ToolUpdateEvent = Extract<AgentSessionEvent, { type: "tool_execution_update" }>;
export type SubagentViewMessage = MessageEvent["message"];
export type SubagentAssistantMessage = Extract<SubagentViewMessage, { role: "assistant" }>;

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
  resume: (params: { ctx: ExtensionContext; sessionId: string; agentType: string }) => Promise<SubagentSession>;
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
    if (message.role === "assistant") turns += 1;
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

export function getPersistedSubagentView(cwd: string, query: string): PersistedSubagentViewResult | undefined {
  const record = resolvePersistedSubagentSession(cwd, query);
  if (!record) return undefined;
  if (record === "ambiguous") return "ambiguous";
  const context = buildSessionContext(record.entries);
  const messages = context.messages as RuntimeMessage[];
  const { toolCount } = collectFromMessages(messages);
  return {
    sessionId: record.sessionId,
    source: {
      cwd: record.cwd,
      agentType: readPersistedAgentType(record.entries),
      status: readPersistedStatus(messages),
      turns: assistantTurnCount(messages),
      toolCount,
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

/**
 * Orchestrate one foreground delegation: spawn (or resume) a subagent session, track it in the
 * registry, await completion, and collect the report. Cancellation of the parent turn (signal)
 * fans out to the whole live subagent subtree rooted at this child. Always resolves with the child
 * session id so the caller can resume or inspect it, even on failure.
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
  let finishReminderQueued = false;
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
      void handle.abort();
    }, args.idleTimeoutMs);
    idleTimer.unref?.();
  };
  const maybeQueueFinishReminder = (assistantToolCalls: number) => {
    if (assistantToolCalls < 1 || finishReminderQueued) return;
    if (typeof handle.steer !== "function") return;
    if (args.maxTurns === undefined || args.maxTurns < 1) return;
    if (assistantTurns < args.maxTurns) return;
    finishReminderQueued = true;
    publishProgress({
      kind: "status",
      text: `turn limit reached (${assistantTurns}/${args.maxTurns}); asking subagent to finish`,
    });
    void handle.steer(MAX_TURNS_FINISH_PROMPT).catch(() => undefined);
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
    resetIdleTimer();
    if (args.signal?.aborted) requestCancellation();
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
  if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") return 0;
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
  if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
    const body = truncateMultiline(rawTextFromContent(event.message.content));
    return { kind: "assistant", text: body ? `assistant\n${body}` : "", turns: 1 };
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
      getMessages: () => session.messages as SubagentViewMessage[],
      getStreamingMessage: () => streamingMessage,
      getActiveTools: () => [...activeTools.values()].map((tool) => ({ ...tool })),
      getToolDefinition: (name) => session.getToolDefinition(name),
      subscribe: (listener) => session.subscribe(listener),
    },
    dispose: unsubscribe,
  };
}

/**
 * Default factory: subagent sessions are ordinary persistent pi sessions in the isolated dir,
 * created in-process via `createAgentSession`. The child re-loads pi-base, restores its delegated
 * depth/root metadata from persisted entries, then performs a real `/agent <name>` activation pass
 * so the delegated agent's own model/thinking/tool policy takes effect. Sessions are headless
 * (no uiContext) — permission prompts relay to the root via the host.
 */
export function createRealSubagentFactory(): SubagentSessionFactory {
  const build = async (
    sm: SessionManager,
    sessionId: string,
    ctx: ExtensionContext,
    agentType: string,
  ): Promise<SubagentSession> => {
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      sessionManager: sm,
      model: ctx.model,
      modelRegistry: ctx.modelRegistry,
    });
    const liveView = createLiveViewSource(session, ctx.cwd);
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        liveView.dispose();
        session.dispose();
      }
    };
    try {
      await session.bindExtensions({});
      // Force a real agent activation pass inside the child session so delegated agents honor their
      // own model/thinking/tool policy instead of inheriting the parent's runtime state.
      await session.prompt(`/agent ${agentType}`);
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
      const sm = SessionManager.create(ctx.cwd, subagentSessionDir(ctx.cwd));
      sm.appendCustomEntry(AGENT_STATE_ENTRY, { name: agentType });
      sm.appendCustomEntry(DEPTH_ENTRY, { depth: childDepth });
      const rootSessionId = readRootSessionId(ctx);
      if (rootSessionId) sm.appendCustomEntry(ROOT_SESSION_ENTRY, rootSessionEntryData(rootSessionId));
      return build(sm, sm.getSessionId(), ctx, agentType);
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
      return build(sm, sm.getSessionId(), ctx, agentType);
    },
  };
}
