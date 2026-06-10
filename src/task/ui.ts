import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import { subagentActivityStore } from "./activity.js";
import { collapseInvocationChain, getSubagentSessionDir, listSubagentSessions } from "./sessions.js";
import { buildTailLines, summarizeTailLines } from "./transcript.js";
import type { SubagentSessionRecord } from "./types.js";
import { SubagentConversationViewer } from "./viewer.js";

function createSelectListTheme(theme: any) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

export function buildSessionRecord(info: Awaited<ReturnType<typeof listSubagentSessions>>[number], sessionDir: string): SubagentSessionRecord {
  const live = subagentActivityStore.get(info.id);
  const manager = SessionManager.open(info.path, sessionDir);
  const invocationChain = collapseInvocationChain(manager.getEntries());
  const currentName = live?.name ?? invocationChain[invocationChain.length - 1] ?? info.name ?? info.id.slice(0, 8);
  const tailLines = live?.tailLines ?? buildTailLines(manager.buildSessionContext().messages, {}, 10);
  return {
    info,
    currentName,
    invocationChain,
    status: live?.status ?? "completed",
    summary: live?.summary ?? summarizeTailLines(tailLines),
    tailLines,
  };
}

function sortSessionRecords(records: SubagentSessionRecord[]): SubagentSessionRecord[] {
  return [...records].sort((left, right) => right.info.modified.getTime() - left.info.modified.getTime());
}

async function showSessionPicker(ctx: ExtensionCommandContext, records: SubagentSessionRecord[]): Promise<SubagentSessionRecord | undefined> {
  const sorted = sortSessionRecords(records);
  if (sorted.length === 0) return undefined;

  return ctx.ui.custom<SubagentSessionRecord | undefined>((tui, theme, _kb, done) => {
    const items = sorted.map((record) => ({
      value: record.info.id,
      label: record.currentName,
      description: `${record.status} · ${record.invocationChain.join(" -> ") || record.currentName} · ${record.summary}`,
    }));

    const selectList = new SelectList(items, Math.min(items.length, 14), createSelectListTheme(theme));
    selectList.onSelect = (item) => done(sorted.find((record) => record.info.id === item.value));
    selectList.onCancel = () => done(undefined);

    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold ? theme.bold("Subagents") : "Subagents")));
    container.addChild(new Text(theme.fg("dim", "Subagent sessions for the current parent session")));
    container.addChild(new Text(""));
    container.addChild(selectList);
    container.addChild(new Text(""));
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter open • esc close")));

    return {
      render(width: number) {
        return container.render(Math.max(40, width));
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  }, { overlay: true });
}

async function showConversationViewer(ctx: ExtensionCommandContext, record: SubagentSessionRecord): Promise<void> {
  const parentSessionDir = typeof ctx.sessionManager.getSessionDir === "function"
    ? ctx.sessionManager.getSessionDir()
    : undefined;
  await ctx.ui.custom<undefined>((tui, theme, _kb, done) => new SubagentConversationViewer(
    tui,
    theme,
    getSubagentSessionDir(ctx.cwd, undefined, parentSessionDir),
    record,
    done,
  ), { overlay: true });
}

export function registerSubagentsCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
  pi.registerCommand("subagents", {
    description: "Browse subagent sessions for the current parent session",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      if (args.trim().length > 0) {
        ctx.ui.notify("Usage: /subagents", "warning");
        return;
      }

      const parentSessionDir = typeof ctx.sessionManager.getSessionDir === "function"
        ? ctx.sessionManager.getSessionDir()
        : undefined;
      const currentParentSessionPath = ctx.sessionManager.getSessionFile();
      const sessionDir = getSubagentSessionDir(ctx.cwd, undefined, parentSessionDir);
      const sessions = await listSubagentSessions(ctx.cwd, undefined, parentSessionDir, currentParentSessionPath);
      if (sessions.length === 0) {
        ctx.ui.notify(`No subagent sessions found for the current parent session in ${sessionDir}`, "info");
        return;
      }

      const records = sessions.map((info) => buildSessionRecord(info, sessionDir));
      const selected = await showSessionPicker(ctx, records);
      if (!selected) return;
      await showConversationViewer(ctx, selected);
    },
  });
}
