import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import { subagentActivityStore } from "./activity.js";
import { getSubagentSessionDir, listSubagentSessions, collapseInvocationChain } from "./sessions.js";
import { buildTailLines, summarizeTailLines } from "./transcript.js";
import type { SubagentSessionRecord, SubagentTreeNode } from "./types.js";
import { SubagentConversationViewer } from "./viewer.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

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

export function buildSubagentTree(records: SubagentSessionRecord[], parentSessionFile?: string): SubagentTreeNode[] {
  const byPath = new Map(records.map((record) => [record.info.path, { record, children: [] as SubagentTreeNode[] }]));
  const roots: SubagentTreeNode[] = [];

  for (const node of byPath.values()) {
    const parentPath = node.record.info.parentSessionPath;
    const parentNode = parentPath ? byPath.get(parentPath) : undefined;
    if (parentNode) {
      parentNode.children.push(node);
      continue;
    }
    if (!parentSessionFile || parentPath === parentSessionFile) {
      roots.push(node);
    }
  }

  const sortNodes = (nodes: SubagentTreeNode[]) => {
    nodes.sort((left, right) => right.record.info.modified.getTime() - left.record.info.modified.getTime());
    for (const node of nodes) sortNodes(node.children);
  };

  sortNodes(roots);
  return roots;
}

export function flattenSubagentTree(nodes: SubagentTreeNode[], depth = 0): Array<{ node: SubagentTreeNode; depth: number }> {
  const flat: Array<{ node: SubagentTreeNode; depth: number }> = [];
  for (const node of nodes) {
    flat.push({ node, depth });
    flat.push(...flattenSubagentTree(node.children, depth + 1));
  }
  return flat;
}

async function showTreePicker(ctx: ExtensionCommandContext, records: SubagentSessionRecord[]): Promise<SubagentSessionRecord | undefined> {
  const nodes = buildSubagentTree(records, ctx.sessionManager.getSessionFile());
  const flattened = flattenSubagentTree(nodes);
  if (flattened.length === 0) return undefined;

  return ctx.ui.custom<SubagentSessionRecord | undefined>((tui, theme, _kb, done) => {
    const items = flattened.map(({ node, depth }) => ({
      value: node.record.info.id,
      label: `${"  ".repeat(depth)}${depth > 0 ? "└─ " : ""}${node.record.currentName}`,
      description: `${node.record.status} · ${node.record.invocationChain.join(" -> ") || node.record.currentName} · ${node.record.summary}`,
    }));

    const selectList = new SelectList(items, Math.min(items.length, 14), createSelectListTheme(theme));
    selectList.onSelect = (item) => done(flattened.find((entry) => entry.node.record.info.id === item.value)?.node.record);
    selectList.onCancel = () => done(undefined);

    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold ? theme.bold("Subagents") : "Subagents")));
    container.addChild(new Text(theme.fg("dim", "Current workspace subagent sessions")));
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
    description: "Browse subagent sessions for the current workspace",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        return;
      }
      if (args.trim().length > 0) {
        ctx.ui.notify("Usage: /subagents", "warning");
        return;
      }

      const parentSessionDir = typeof ctx.sessionManager.getSessionDir === "function"
        ? ctx.sessionManager.getSessionDir()
        : undefined;
      const sessionDir = getSubagentSessionDir(ctx.cwd, undefined, parentSessionDir);
      const sessions = await listSubagentSessions(ctx.cwd, undefined, parentSessionDir);
      if (sessions.length === 0) {
        ctx.ui.notify(`No subagent sessions found in ${sessionDir}`, "info");
        return;
      }

      const records = sessions.map((info) => buildSessionRecord(info, sessionDir));
      const selected = await showTreePicker(ctx, records);
      if (!selected) return;
      await showConversationViewer(ctx, selected);
    },
  });
}
