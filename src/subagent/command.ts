import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isRootSession, readRootSessionId } from "./depth.js";
import { subagentRegistry, type SubagentNode } from "./registry.js";
import { getLiveSubagentView } from "./runner.js";
import { SubagentSessionPanel } from "./session-panel.js";

function formatChoice(node: SubagentNode): string {
  const activity = node.lastActivity ? ` · ${node.lastActivity}` : "";
  return `${node.agentType} · ${node.status} · turns: ${node.turns} · tool calls: ${node.toolCount} · ${node.sessionId}${activity}`;
}

function resolveRequestedNode(nodes: SubagentNode[], query: string): SubagentNode | undefined {
  const exact = nodes.find((node) => node.sessionId === query);
  if (exact) return exact;
  const prefixed = nodes.filter((node) => node.sessionId.startsWith(query));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

async function selectNode(ctx: ExtensionCommandContext, nodes: SubagentNode[]): Promise<SubagentNode | undefined> {
  if (nodes.length === 1) return nodes[0];
  const nodeByLabel = new Map<string, SubagentNode>();
  const labels = nodes.map((node) => {
    const label = formatChoice(node);
    nodeByLabel.set(label, node);
    return label;
  });
  const selected = await ctx.ui.select("View running subagent", labels);
  return selected ? nodeByLabel.get(selected) : undefined;
}

export function registerSubagentCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
  pi.registerCommand("subagent", {
    description: "View a running subagent session",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI || ctx.mode !== "tui" || !isRootSession(ctx)) {
        ctx.ui.notify("/subagent requires the root interactive UI.", "warning");
        return;
      }

      const rootSessionId = readRootSessionId(ctx) || ctx.sessionManager.getSessionId();
      const nodes = subagentRegistry
        .forRoot(rootSessionId)
        .filter((node) => node.status === "running" && getLiveSubagentView(node.sessionId) !== undefined)
        .sort((left, right) => left.startedAt - right.startedAt);
      const query = args.trim();
      if (nodes.length === 0) {
        ctx.ui.notify("No running subagents are available to view.", "info");
        return;
      }

      const node = query ? resolveRequestedNode(nodes, query) : await selectNode(ctx, nodes);
      if (!node) {
        if (query) ctx.ui.notify(`Running subagent "${query}" was not found or is ambiguous.`, "warning");
        return;
      }
      const source = getLiveSubagentView(node.sessionId);
      if (!source) {
        ctx.ui.notify(`Subagent "${node.sessionId}" finished before the panel opened.`, "info");
        return;
      }

      await ctx.ui.custom<void>((tui, theme, keybindings, done) => new SubagentSessionPanel({
        tui,
        theme,
        keybindings,
        done: () => done(undefined),
        sessionId: node.sessionId,
        source,
        getNode: () => subagentRegistry.get(node.sessionId),
        subscribeRegistry: (listener) => subagentRegistry.onChange(listener),
      }), {
        overlay: true,
        overlayOptions: {
          width: "100%",
          maxHeight: "100%",
          anchor: "center",
          margin: { top: 1, right: 0, bottom: 1, left: 0 },
        },
      });
    },
  });
}
