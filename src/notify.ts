import { getAgentDir, type AgentEndEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedPiBaseSettings, NotifyConfig } from "./config.js";

const DEFAULT_NOTIFY_COMMAND = [resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "notify.sh")];
const SUPPRESS_COMPLETED_DEFAULT_MS = 5_000;
const PI_SETTINGS_FILE = "settings.json";
const PI_PROJECT_SETTINGS_DIR = ".pi";
const PI_RETRY_MAX_RETRIES_DEFAULT = 3;

interface PiRuntimeFinalitySettings {
  retryEnabled: boolean;
  maxRetries: number;
  compactionEnabled: boolean;
}

export type PiBaseNotifyKind = "permission.requested" | "session.completed" | "session.error";

export interface PiBaseNotifyPayload {
  kind: PiBaseNotifyKind;
  cwd: string;
  projectName: string;
  sessionID: string;
  sessionTitle: string;
}

export interface RegisterNotifySupportOptions {
  loadSettings?: (cwd: string) => LoadedPiBaseSettings;
  sendNotification?: (payload: PiBaseNotifyPayload, ctx: ExtensionContext) => Promise<void>;
}

export interface NotifyPermissionAskedInput {
  ctx: ExtensionContext;
}

export interface NotifyPermissionRejectedInput {
  ctx: ExtensionContext;
}

export interface NotifySupportHooks {
  onPermissionAsked(input: NotifyPermissionAskedInput): Promise<void>;
  onPermissionRejected(input: NotifyPermissionRejectedInput): void;
}

export function registerNotifySupport(
  pi: Pick<ExtensionAPI, "on">,
  options: RegisterNotifySupportOptions = {},
): NotifySupportHooks {
  const loadSettings = options.loadSettings;
  const sendNotification = options.sendNotification ?? createShellNotificationSender(loadSettings);
  const suppressCompletedUntil = new Map<string, number>();
  // Sessions that already emitted a permission notification for their current turn.
  // A model round (one assistant message plus its whole tool-call batch) is a single
  // "turn", and permission prompts within it are serialized, so we notify only once
  // per turn. The marker is reset on the next `turn_start`, so this holds at most one
  // entry per active session with no timers, time windows, or eviction bookkeeping.
  const permissionNotifiedTurns = new Set<string>();

  pi.on("turn_start", async (_event, ctx) => {
    const sessionID = resolveSessionId(ctx);
    if (sessionID) permissionNotifiedTurns.delete(sessionID);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionID = resolveSessionId(ctx);
    if (!sessionID) return;
    permissionNotifiedTurns.delete(sessionID);
    suppressCompletedUntil.delete(sessionID);
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
    const loaded = loadSettings?.(ctx.cwd);
    if (!shouldNotifyForAgentEnd(loaded?.settings.notify, ctx, event)) return;

    const kind = resolveAgentEndNotificationKind(event, ctx);
    if (!kind) return;

    const payload = buildPayload(kind, ctx);
    if (!payload.sessionID) return;
    const suppressedUntil = suppressCompletedUntil.get(payload.sessionID) ?? 0;
    if (kind === "session.completed" && Date.now() < suppressedUntil) return;
    suppressCompletedUntil.delete(payload.sessionID);

    await sendNotification(payload, ctx);
  });

  return {
    async onPermissionAsked({ ctx }) {
      if (!shouldNotifyForPermissionAsk(loadSettings?.(ctx.cwd)?.settings.notify, ctx)) return;
      const payload = buildPayload("permission.requested", ctx);
      // Collapse a model round's whole tool-call batch into one alert: only the first
      // permission ask of the current turn notifies. Subsequent asks in the same turn
      // (e.g. 5 edits at once) are suppressed until the next turn_start resets the marker.
      if (payload.sessionID) {
        if (permissionNotifiedTurns.has(payload.sessionID)) return;
        permissionNotifiedTurns.add(payload.sessionID);
      }
      await sendNotification(payload, ctx);
    },
    onPermissionRejected({ ctx }) {
      const notify = loadSettings?.(ctx.cwd)?.settings.notify;
      if (!notify) return;
      const window = suppressCompletedWindowMs(notify);
      if (window <= 0) return;
      const payload = buildPayload("session.completed", ctx);
      if (!payload.sessionID) return;
      suppressCompletedUntil.set(payload.sessionID, Date.now() + window);
    },
  };
}

function createShellNotificationSender(
  loadSettings: ((cwd: string) => LoadedPiBaseSettings) | undefined,
): (payload: PiBaseNotifyPayload, ctx: ExtensionContext) => Promise<void> {
  return async (payload, ctx) => {
    const notify = loadSettings?.(ctx.cwd)?.settings.notify;
    if (!notify) return;

    const command = getNotifyCommand();
    if (command.length === 0) return;
    if (!existsSync(command[0]!)) return;

    const [executable, ...args] = command;
    const child = spawn(executable!, args, {
      cwd: ctx.cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        PI_NOTIFY_KIND: payload.kind,
        PI_NOTIFY_PROJECT: payload.projectName,
        PI_NOTIFY_SESSION_ID: payload.sessionID,
        PI_NOTIFY_SESSION_TITLE: payload.sessionTitle,
        PI_NOTIFY_TMUX_PANE: process.env.TMUX_PANE ?? "",
        PI_NOTIFY_ALACRITTY_WINDOW_ID: process.env.ALACRITTY_WINDOW_ID ?? "",
      },
    });
    child.on("error", () => undefined);
    child.unref();
  };
}

function getNotifyCommand(): string[] {
  return [...DEFAULT_NOTIFY_COMMAND];
}

function suppressCompletedWindowMs(config: NotifyConfig | undefined): number {
  const value = config?.suppressCompletedAfterRejectionMs;
  if (value === undefined) return SUPPRESS_COMPLETED_DEFAULT_MS;
  return value;
}

function shouldNotifyForPermissionAsk(config: NotifyConfig | undefined, ctx: ExtensionContext): boolean {
  return ctx.hasUI && config?.permissionAsked === true;
}

function shouldNotifyForAgentEnd(config: NotifyConfig | undefined, ctx: ExtensionContext, _event: AgentEndEvent): boolean {
  return ctx.hasUI && config?.agentEnd === true;
}

function resolveAgentEndNotificationKind(
  event: AgentEndEvent,
  ctx: ExtensionContext,
): Exclude<PiBaseNotifyKind, "permission.requested"> | undefined {
  const assistant = findLastAssistantMessage(event.messages);
  if (!assistant) return "session.completed";
  if (assistant.stopReason === "aborted") return undefined;
  if (assistant.stopReason !== "error") return "session.completed";

  const finality = loadPiRuntimeFinalitySettings(ctx.cwd);
  const overflowSignal = isContextOverflow(assistant, ctx.model?.contextWindow);
  if (finality.compactionEnabled && overflowSignal) {
    const overflowErrorCount = countTrailingAssistantErrors(ctx, assistant, (message) => isContextOverflow(message, ctx.model?.contextWindow));
    if (overflowErrorCount <= 1) return undefined;
  }

  const retryableSignal = isRetryableAssistantError(assistant);
  if (finality.retryEnabled && retryableSignal) {
    const retryableErrorCount = countTrailingAssistantErrors(ctx, assistant, isRetryableAssistantError);
    if (retryableErrorCount <= finality.maxRetries) return undefined;
  }

  return "session.error";
}

function findLastAssistantMessage(messages: AgentEndEvent["messages"]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isAssistantMessage(message)) return message;
  }
  return undefined;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return !!message && typeof message === "object" && (message as { role?: unknown }).role === "assistant";
}

function countTrailingAssistantErrors(
  ctx: ExtensionContext,
  currentAssistant: AssistantMessage,
  predicate: (message: AssistantMessage) => boolean,
): number {
  const entries = ctx.sessionManager.getEntries?.() ?? [];
  let count = 0;
  let sawCurrent = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; message?: unknown };
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (!isAssistantMessage(message) || message.stopReason !== "error" || !predicate(message)) break;
    count += 1;
    if (message.timestamp === currentAssistant.timestamp) sawCurrent = true;
  }
  return sawCurrent ? count : count + 1;
}

function loadPiRuntimeFinalitySettings(cwd: string): PiRuntimeFinalitySettings {
  const globalSettings = readJsonObjectSafe(join(getAgentDir(), PI_SETTINGS_FILE));
  const projectSettings = readJsonObjectSafe(join(resolve(cwd), PI_PROJECT_SETTINGS_DIR, PI_SETTINGS_FILE));
  const globalRetry = asRecord(globalSettings.retry);
  const projectRetry = asRecord(projectSettings.retry);
  const globalCompaction = asRecord(globalSettings.compaction);
  const projectCompaction = asRecord(projectSettings.compaction);
  const retryEnabled = readBoolean(projectRetry.enabled) ?? readBoolean(globalRetry.enabled) ?? true;
  const maxRetries = readNonNegativeInteger(projectRetry.maxRetries)
    ?? readNonNegativeInteger(globalRetry.maxRetries)
    ?? PI_RETRY_MAX_RETRIES_DEFAULT;
  const compactionEnabled = readBoolean(projectCompaction.enabled) ?? readBoolean(globalCompaction.enabled) ?? true;
  return { retryEnabled, maxRetries, compactionEnabled };
}

function readJsonObjectSafe(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function buildPayload(kind: PiBaseNotifyKind, ctx: ExtensionContext): PiBaseNotifyPayload {
  const projectName = basename(ctx.cwd) || ctx.cwd;
  const sessionID = resolveSessionId(ctx);
  // sessionTitle is rendered into the notification body as
  // `[project] title`. If the session has no name, leave it empty so
  // the bash script can fall back to a project-only body instead of
  // showing the session UUID.
  const sessionName = ctx.sessionManager.getSessionName?.() ?? "";
  const sessionTitle = sessionName.trim();
  return {
    kind,
    cwd: ctx.cwd,
    projectName,
    sessionID,
    sessionTitle,
  };
}

// Stable per-session key used both for the notification payload and for the
// per-turn permission-dedup marker, so both derive the id the same way.
function resolveSessionId(ctx: ExtensionContext): string {
  return String(ctx.sessionManager.getSessionId?.() ?? basename(ctx.sessionManager.getSessionFile?.() ?? ""));
}
