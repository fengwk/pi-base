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
    description: "",
    depth: 2,
    status: "running",
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

  it("lists only running subagents, indented by depth, oldest first", () => {
    // Intent: the widget visualizes concurrent + nested in-flight subagents as a depth-indented tree.
    const lines = renderSubagentWidget([
      node({ sessionId: "b", agentType: "writer", depth: 3, toolCount: 1, startedAt: 20 }),
      node({ sessionId: "a", agentType: "mathworker", depth: 2, toolCount: 4, startedAt: 10 }),
      node({ sessionId: "c", agentType: "ignored", status: "done", startedAt: 5 }),
    ]);
    expect(lines).toEqual([
      "⟳ subagents running (2)",
      "• mathworker · 4 tools",
      "  • writer · 1 tool",
    ]);
  });

  it("omits the tool suffix while a running subagent has no observed tool calls yet", () => {
    // Intent: during execution, 0 does not mean a confirmed final count, so the widget should not mislead.
    expect(renderSubagentWidget([node({ agentType: "mathworker", toolCount: 0 })])).toEqual([
      "⟳ subagents running (1)",
      "• mathworker",
    ]);
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
    expect(registry.getWidget(SUBAGENT_WIDGET_KEY)).toEqual(["⟳ subagents running (1)", "• mathworker"]);

    subagentRegistry.update("x", { status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(registry.getWidget(SUBAGENT_WIDGET_KEY)).toBeUndefined();
  });
});
