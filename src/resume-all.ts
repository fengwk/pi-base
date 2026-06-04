import {
  SessionManager,
  SessionSelectorComponent,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { shortenHomePath } from "./render.js";

type SessionListProgress = (loaded: number, total: number) => void;
type ListAllWithSessionDir = (sessionDir?: string, onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

function truncateLabel(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function buildSessionLabel(session: SessionInfo): string {
  const title = truncateLabel((session.name?.trim() || session.firstMessage || "(no messages)").replace(/\s+/g, " "), 60);
  const cwd = session.cwd ? shortenHomePath(session.cwd) : "<unknown cwd>";
  const path = shortenHomePath(session.path);
  return `${title} — ${cwd} — ${path}`;
}

function getDefaultSessionDirPath(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const resolvedAgentDir = resolve(getAgentDir());
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolvedAgentDir, "sessions", safePath);
}

function usesDefaultSessionDir(ctx: ExtensionCommandContext): boolean {
  return resolve(ctx.sessionManager.getSessionDir()) === getDefaultSessionDirPath(ctx.sessionManager.getCwd());
}

function listAllSessions(ctx: ExtensionCommandContext, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
  if (usesDefaultSessionDir(ctx)) {
    return SessionManager.listAll(onProgress);
  }
  return (SessionManager.listAll as unknown as ListAllWithSessionDir)(ctx.sessionManager.getSessionDir(), onProgress);
}

async function selectSessionWithPicker(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const sessions = await listAllSessions(ctx);
  if (sessions.length === 0) {
    ctx.ui.notify("No sessions found.", "info");
    return undefined;
  }

  const choiceByLabel = new Map<string, SessionInfo>();
  const labels = sessions.map((session) => {
    const label = formatResumeAllChoice(session);
    choiceByLabel.set(label, session);
    return label;
  });

  const selected = await ctx.ui.select("Resume session from any project", labels);
  return selected ? choiceByLabel.get(selected)?.path : undefined;
}

async function selectSessionWithSelector(ctx: ExtensionCommandContext): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
    const selector = new SessionSelectorComponent(
      (onProgress) => SessionManager.list(ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionDir(), onProgress),
      (onProgress) => listAllSessions(ctx, onProgress),
      (sessionPath) => done(sessionPath),
      () => done(undefined),
      () => done(undefined),
      () => tui.requestRender(),
      { keybindings },
      ctx.sessionManager.getSessionFile(),
    );

    queueMicrotask(() => {
      const privateApi = selector as unknown as {
        toggleScope?: () => void;
        toggleSortMode?: () => void;
      };
      privateApi.toggleSortMode?.call(selector);
      privateApi.toggleScope?.call(selector);
    });

    return selector;
  });
}

export function formatResumeAllChoice(session: SessionInfo): string {
  return buildSessionLabel(session);
}

export function registerResumeAllCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
  pi.registerCommand("resume-all", {
    description: "Resume a session from any project directory",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim().length > 0) {
        ctx.ui.notify("Usage: /resume-all", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/resume-all requires interactive UI.", "warning");
        return;
      }

      const mode = (ctx as ExtensionCommandContext & { mode?: string }).mode;
      const sessionPath = mode === "tui" ? await selectSessionWithSelector(ctx) : await selectSessionWithPicker(ctx);
      if (!sessionPath) return;

      const result = await ctx.switchSession(sessionPath, {
        withSession: async (nextCtx) => {
          nextCtx.ui.notify("Resumed session", "info");
        },
      });
      if (result.cancelled) {
        ctx.ui.notify("Resume cancelled.", "info");
      }
    },
  });
}
