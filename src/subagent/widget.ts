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
 * Depth drives indentation, giving a tree-like view without walking the full parent chain.
 * Top-level subagents (depth 2) sit flush under the header; each further nesting level adds one
 * indent step.
 */
export function renderSubagentWidget(nodes: SubagentNode[]): string[] | undefined {
  const running = nodes
    .filter((node) => node.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt);
  if (running.length === 0) return undefined;

  const lines = [`⟳ subagents running (${running.length})`];
  for (const node of running) {
    const indent = "  ".repeat(Math.max(0, node.depth - 2));
    const tools = node.toolCount === 1 ? "1 tool" : `${node.toolCount} tools`;
    lines.push(`${indent}• ${node.agentType} · ${tools}`);
  }
  return lines;
}
