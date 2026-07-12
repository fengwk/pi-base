import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { SubagentNode } from "./registry.js";

/** Widget key for the root session's live subagent tree. */
export const SUBAGENT_WIDGET_KEY = "pi-base-subagents";

const ACTIVITY_SEPARATOR = " · ";
const MIN_ACTIVITY_COLUMNS = 12;
const MAX_WIDGET_LINES = 10;

function formatNodeLine(treePrefix: string, node: SubagentNode, maxWidth: number): string {
  const counters = ` - turns: ${node.turns} · tool calls: ${node.toolCount}`;
  let agentType = node.agentType;

  if (Number.isFinite(maxWidth)) {
    const agentWidth = Math.max(1, maxWidth - visibleWidth(treePrefix) - visibleWidth(counters));
    agentType = truncateToWidth(agentType, agentWidth, "…");
  }

  const base = `${treePrefix}${agentType}${counters}`;
  const activity = node.lastActivity?.replace(/\s+/g, " ").trim();
  if (!activity) return Number.isFinite(maxWidth) ? truncateToWidth(base, maxWidth, "…") : base;
  if (!Number.isFinite(maxWidth)) return `${base}${ACTIVITY_SEPARATOR}${activity}`;

  const activityWidth = maxWidth - visibleWidth(base) - visibleWidth(ACTIVITY_SEPARATOR);
  if (activityWidth < MIN_ACTIVITY_COLUMNS) return truncateToWidth(base, maxWidth, "…");
  return `${base}${ACTIVITY_SEPARATOR}${truncateToWidth(activity, activityWidth, "…")}`;
}

/**
 * Render the live subagent tree as widget lines (or `undefined` to clear the widget).
 * Each running node occupies exactly one line; its latest activity is truncated to the
 * remaining terminal width so progress updates never increase the widget height.
 */
export function renderSubagentWidget(
  nodes: SubagentNode[],
  rootSessionId?: string,
  maxWidth = Number.POSITIVE_INFINITY,
): string[] | undefined {
  const running = nodes.filter((node) => node.status === "running");
  if (running.length === 0) return undefined;

  const childrenByParent = new Map<string, SubagentNode[]>();
  const nodeIds = new Set(running.map((node) => node.sessionId));
  for (const node of running) {
    const children = childrenByParent.get(node.parentSessionId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentSessionId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.startedAt - b.startedAt);
  }

  const roots = rootSessionId
    ? [...(childrenByParent.get(rootSessionId) ?? [])]
    : running.filter((node) => !nodeIds.has(node.parentSessionId)).sort((a, b) => a.startedAt - b.startedAt);
  const rootIds = new Set(roots.map((node) => node.sessionId));
  for (const node of running) {
    if (!rootIds.has(node.sessionId) && !nodeIds.has(node.parentSessionId)) {
      roots.push(node);
      rootIds.add(node.sessionId);
    }
  }

  const lines = [truncateToWidth(`⟳ subagents running (${running.length})`, maxWidth, "…")];
  const visited = new Set<string>();
  const renderNode = (node: SubagentNode, prefix: string, isLast: boolean): void => {
    if (visited.has(node.sessionId)) return;
    visited.add(node.sessionId);
    lines.push(formatNodeLine(`${prefix}${isLast ? "└─ " : "├─ "}`, node, maxWidth));
    const children = childrenByParent.get(node.sessionId) ?? [];
    const childPrefix = `${prefix}${isLast ? "   " : "│  "}`;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child) renderNode(child, childPrefix, i === children.length - 1);
    }
  };

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    if (root) renderNode(root, "", i === roots.length - 1);
  }

  const orphans = running.filter((node) => !visited.has(node.sessionId)).sort((a, b) => a.startedAt - b.startedAt);
  for (let i = 0; i < orphans.length; i++) {
    const orphan = orphans[i];
    if (orphan) renderNode(orphan, "", i === orphans.length - 1);
  }
  return lines;
}

export function createSubagentWidgetComponent(nodes: SubagentNode[], rootSessionId?: string): Component {
  return {
    render(width: number): string[] {
      const lines = renderSubagentWidget(nodes, rootSessionId, Math.max(0, width));
      if (!lines || lines.length <= MAX_WIDGET_LINES) return lines ?? [];
      return [
        ...lines.slice(0, MAX_WIDGET_LINES),
        truncateToWidth("... (widget truncated)", Math.max(0, width), "…"),
      ];
    },
    invalidate(): void {},
  };
}
