import type { SubagentNode } from "./registry.js";

/** Widget key for the root session's live subagent tree. */
export const SUBAGENT_WIDGET_KEY = "pi-base-subagents";

/**
 * Render the live subagent tree as widget lines (or `undefined` to clear the widget).
 *
 * Only *running* subagents are shown: the widget exists to visualize in-flight delegation
 * (parallel batches and nested depth) while a `task` call blocks the parent turn. Finished
 * nodes stay in the registry with a terminal status but are intentionally omitted here, so the
 * widget appears during active delegation and disappears once everything settles.
 *
 * Parent/child links drive indentation. Top-level subagents sit flush under the header;
 * each child level adds one indent step. Siblings keep start-time order within their parent.
 */
export function renderSubagentWidget(nodes: SubagentNode[], rootSessionId?: string): string[] | undefined {
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

  const lines = [`⟳ subagents running (${running.length})`];
  const visited = new Set<string>();
  const renderNode = (node: SubagentNode, level: number) => {
    if (visited.has(node.sessionId)) return;
    visited.add(node.sessionId);
    const indent = "  ".repeat(Math.max(0, level));
    lines.push(`${indent}• ${node.agentType} - turns: ${node.turns} · tool calls: ${node.toolCount}`);
    for (const child of childrenByParent.get(node.sessionId) ?? []) renderNode(child, level + 1);
  };

  const roots = rootSessionId
    ? [...(childrenByParent.get(rootSessionId) ?? [])]
    : running.filter((node) => !nodeIds.has(node.parentSessionId)).sort((a, b) => a.startedAt - b.startedAt);
  for (const root of roots) renderNode(root, 0);

  const orphans = running.filter((node) => !visited.has(node.sessionId)).sort((a, b) => a.startedAt - b.startedAt);
  for (const orphan of orphans) renderNode(orphan, 0);
  return lines;
}
