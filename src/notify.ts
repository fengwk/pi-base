import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { LoadedPiBaseSettings, NotifyConfig } from "./config.js";

const DEFAULT_NOTIFY_COMMAND = [join(homedir(), ".pi", "agent", "scripts", "notify.sh")];
const SUPPRESS_COMPLETED_MS = 2_000;

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
      const payload = buildPayload("session.completed", ctx);
      if (!payload.sessionID) return;
      suppressCompletedUntil.set(payload.sessionID, Date.now() + SUPPRESS_COMPLETED_MS);
    },
  };
}

function createShellNotificationSender(
  loadSettings: ((cwd: string) => LoadedPiBaseSettings) | undefined,
): (payload: PiBaseNotifyPayload, ctx: ExtensionContext) => Promise<void> {
  return async (payload, ctx) => {
    const notify = loadSettings?.(ctx.cwd).settings.notify;
    if (!notify || notify.enabled === false) return;

    const command = getNotifyCommand(notify);
    if (command.length === 0) return;
    if ((command[0]!.includes("/") || command[0]!.includes("\\")) && !existsSync(command[0]!)) return;

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

function getNotifyCommand(config: NotifyConfig | undefined): string[] {
  return config?.command?.length ? [...config.command] : DEFAULT_NOTIFY_COMMAND;
}

function shouldNotifyForPermissionAsk(config: NotifyConfig | undefined, ctx: ExtensionContext): boolean {
  return ctx.hasUI && config?.enabled === true && config.permissionAsked !== false;
}

function shouldNotifyForAgentEnd(config: NotifyConfig | undefined, ctx: ExtensionContext, _event: AgentEndEvent): boolean {
  return ctx.hasUI && config?.enabled === true && config.agentEnd !== false;
}

function buildPayload(kind: PiBaseNotifyKind, ctx: ExtensionContext): PiBaseNotifyPayload {
  const projectName = basename(ctx.cwd) || ctx.cwd;
  const sessionID = String(ctx.sessionManager.getSessionId?.() ?? basename(ctx.sessionManager.getSessionFile?.() ?? ""));
  const sessionName = ctx.sessionManager.getSessionName?.();
  const sessionTitle = sessionName && sessionName.trim().length > 0 ? sessionName : (sessionID || projectName);
  return {
    kind,
    cwd: ctx.cwd,
    projectName,
    sessionID,
    sessionTitle,
  };
}
