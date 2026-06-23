import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedPiBaseSettings, NotifyConfig } from "./config.js";

const DEFAULT_NOTIFY_COMMAND = [resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "notify.sh")];
const SUPPRESS_COMPLETED_DEFAULT_MS = 2_000;

export type PiBaseNotifyKind = "permission.requested" | "session.completed";

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

  pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
    if (!shouldNotifyForAgentEnd(loadSettings?.(ctx.cwd).settings.notify, ctx, event)) return;

    const payload = buildPayload("session.completed", ctx);
    if (!payload.sessionID) return;
    const suppressedUntil = suppressCompletedUntil.get(payload.sessionID) ?? 0;
    if (Date.now() < suppressedUntil) return;

    await sendNotification(payload, ctx);
  });

  return {
    async onPermissionAsked({ ctx }) {
      if (!shouldNotifyForPermissionAsk(loadSettings?.(ctx.cwd).settings.notify, ctx)) return;
      await sendNotification(buildPayload("permission.requested", ctx), ctx);
    },
    onPermissionRejected({ ctx }) {
      const window = suppressCompletedWindowMs(loadSettings?.(ctx.cwd).settings.notify);
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
    const notify = loadSettings?.(ctx.cwd).settings.notify;
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

function buildPayload(kind: PiBaseNotifyKind, ctx: ExtensionContext): PiBaseNotifyPayload {
  const projectName = basename(ctx.cwd) || ctx.cwd;
  const sessionID = String(ctx.sessionManager.getSessionId?.() ?? basename(ctx.sessionManager.getSessionFile?.() ?? ""));
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
