import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { subagentRegistry, type SubagentNode } from "../src/subagent/registry.js";
import { renderSubagentWidget, SUBAGENT_WIDGET_KEY } from "../src/subagent/widget.js";
import { createTempWorkspace, createToolRegistry } from "./helpers.js";

function node(overrides: Partial<SubagentNode>): SubagentNode {
  return {
    sessionId: "s",
    parentSessionId: "root",
    rootSessionId: "test-session",
    agentType: "worker",
    depth: 2,
    status: "running",
    turns: 0,
    toolCount: 0,
    startedAt: 1,
    ...overrides,
  };
}

const defaultModel = { provider: "provider-a", id: "model-a" };

describe("renderSubagentWidget", () => {
  beforeEach(() => subagentRegistry.clear());
  afterEach(() => subagentRegistry.clear());

  it("returns undefined when nothing is running", () => {
    // Intent: widget clears itself when there is no in-flight delegation.
    expect(renderSubagentWidget([])).toBeUndefined();
    expect(renderSubagentWidget([node({ status: "done" }), node({ status: "error" })])).toBeUndefined();
  });

  it("lists only running subagents as a true parent/child tree", () => {
    // Intent: the widget must follow parentSessionId, not global depth/start ordering, so
    // concurrent sibling branches remain unambiguous.
    const lines = renderSubagentWidget([
      node({ sessionId: "a", parentSessionId: "root", agentType: "planner", depth: 2, turns: 3, toolCount: 4, lastActivity: "✓ read src/a.ts", startedAt: 10 }),
      node({ sessionId: "b", parentSessionId: "root", agentType: "builder", depth: 2, turns: 2, lastActivity: "→ bash npm test", startedAt: 20 }),
      node({ sessionId: "b1", parentSessionId: "b", agentType: "builder-child", depth: 3, turns: 1, startedAt: 25 }),
      node({ sessionId: "a1", parentSessionId: "a", agentType: "planner-child", depth: 3, turns: 5, toolCount: 1, startedAt: 30 }),
      node({ sessionId: "c", agentType: "ignored", status: "done", startedAt: 5 }),
    ], "root");
    expect(lines).toEqual([
      "⟳ subagents running (4)",
      "├─ planner - turns: 3 · tool calls: 4 · ✓ read src/a.ts",
      "│  └─ planner-child - turns: 5 · tool calls: 1",
      "└─ builder - turns: 2 · tool calls: 0 · → bash npm test",
      "   └─ builder-child - turns: 1 · tool calls: 0",
    ]);
  });

  it("shows zero live counters before a running subagent reports progress", () => {
    // Intent: the widget owns live task counters, so its shape stays stable from startup through completion.
    expect(renderSubagentWidget([node({ agentType: "mathworker" })])).toEqual([
      "⟳ subagents running (1)",
      "└─ mathworker - turns: 0 · tool calls: 0",
    ]);
  });

  it("truncates the latest activity to keep every tree node on one physical line", () => {
    // Intent: long tool arguments must consume only the width left after the tree, agent, and counters.
    const width = 72;
    const lines = renderSubagentWidget([
      node({
        agentType: "explorer",
        turns: 58,
        toolCount: 58,
        lastActivity: '✓ read {"path":"src/components/a-very-long-file-name-that-must-not-wrap.ts"}',
      }),
    ], "root", width);
    const activityLine = lines?.[1] ?? "";
    expect(activityLine).toContain("└─ explorer - turns: 58 · tool calls: 58 · ✓ read");
    expect(activityLine).toContain("…");
    expect(visibleWidth(activityLine)).toBeLessThanOrEqual(width);

    const narrowLine = renderSubagentWidget([
      node({ agentType: "explorer", turns: 58, toolCount: 58, lastActivity: "✓ read src/a.ts" }),
    ], "root", 48)?.[1] ?? "";
    expect(narrowLine).toBe("└─ explorer - turns: 58 · tool calls: 58");
  });

  it("wires the registry to the root session widget and isolates foreign roots", async () => {
    // Intent: only the current root session's tree should render in its widget; foreign-root nodes
    // must stay hidden even though the registry is process-global.
    const root = await createTempWorkspace();
    const registry = createToolRegistry({ model: defaultModel, models: [defaultModel] });
    piBaseExtension(registry.pi as never);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    subagentRegistry.upsert(node({ sessionId: "foreign", agentType: "ignored", rootSessionId: "other-root", status: "running" }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(registry.getWidget(SUBAGENT_WIDGET_KEY)).toBeUndefined();

    subagentRegistry.upsert(node({ sessionId: "x", agentType: "mathworker", status: "running" }));
    await new Promise((resolve) => setTimeout(resolve, 80)); // let the 50ms throttle flush
    expect(registry.getWidget(SUBAGENT_WIDGET_KEY)).toEqual([
      "⟳ subagents running (1)",
      "└─ mathworker - turns: 0 · tool calls: 0",
    ]);

    subagentRegistry.update("x", { turns: 58, toolCount: 58, lastActivity: '✓ read {"path":"src/a.ts"}' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(registry.getWidget(SUBAGENT_WIDGET_KEY)).toEqual([
      "⟳ subagents running (1)",
      '└─ mathworker - turns: 58 · tool calls: 58 · ✓ read {"path":"src/a.ts"}',
    ]);

    subagentRegistry.update("x", { status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(registry.getWidget(SUBAGENT_WIDGET_KEY)).toBeUndefined();
  });

  it("clears the widget and cancels queued renders on session shutdown", async () => {
    // Intent: a render scheduled before session teardown must not restore stale UI after shutdown.
    const root = await createTempWorkspace();
    const registry = createToolRegistry({ model: defaultModel, models: [defaultModel] });
    piBaseExtension(registry.pi as never);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    subagentRegistry.upsert(node({ sessionId: "x", agentType: "mathworker", status: "running" }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(registry.getWidget(SUBAGENT_WIDGET_KEY)).toEqual([
      "⟳ subagents running (1)",
      "└─ mathworker - turns: 0 · tool calls: 0",
    ]);

    subagentRegistry.update("x", { toolCount: 1 });
    await registry.emit("session_shutdown", { reason: "quit" }, { cwd: root });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(registry.getWidget(SUBAGENT_WIDGET_KEY)).toBeUndefined();
  });
});
