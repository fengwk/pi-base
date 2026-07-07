import { describe, expect, it, vi } from "vitest";
import { DEPTH_ENTRY, ROOT_DEPTH, depthEntryData, isRootSession, readDepth } from "../src/subagent/depth.js";
import { SubagentRegistry, type SubagentNode } from "../src/subagent/registry.js";
import {
  askSubagentPermissionHost,
  clearSubagentPermissionHost,
  hasSubagentPermissionHost,
  setSubagentPermissionHost,
} from "../src/subagent/permission-host.js";

interface Entry {
  type: string;
  customType?: string;
  data?: unknown;
}

function ctxWithEntries(entries: Entry[]): { sessionManager: { getEntries: () => Entry[] } } {
  return { sessionManager: { getEntries: () => entries } };
}

describe("subagent depth", () => {
  it("defaults to root depth when no depth entry exists", () => {
    // Intent: a plain user session has no depth entry and must be treated as the root (1).
    const ctx = ctxWithEntries([{ type: "message" }, { type: "custom", customType: "other", data: {} }]);
    expect(readDepth(ctx as never)).toBe(ROOT_DEPTH);
    expect(isRootSession(ctx as never)).toBe(true);
  });

  it("reads the latest depth entry and treats deeper sessions as non-root", () => {
    // Intent: the most recent depth entry wins (mirrors agent-state's last-entry semantics).
    const ctx = ctxWithEntries([
      { type: "custom", customType: DEPTH_ENTRY, data: depthEntryData(2) },
      { type: "custom", customType: DEPTH_ENTRY, data: depthEntryData(3) },
    ]);
    expect(readDepth(ctx as never)).toBe(3);
    expect(isRootSession(ctx as never)).toBe(false);
  });

  it("ignores malformed depth values", () => {
    // Intent: corrupt/hand-edited entries must not crash or yield an impossible depth.
    const ctx = ctxWithEntries([{ type: "custom", customType: DEPTH_ENTRY, data: { depth: "nope" } }]);
    expect(readDepth(ctx as never)).toBe(ROOT_DEPTH);
  });
});

describe("SubagentRegistry", () => {
  const node = (id: string, parent: string, status: SubagentNode["status"] = "running"): SubagentNode => ({
    sessionId: id,
    parentSessionId: parent,
    agentType: "worker",
    description: "task",
    depth: 2,
    status,
    toolCount: 0,
    startedAt: 0,
  });

  it("tracks nodes, children, and running counts", () => {
    // Intent: the tree view and concurrency guard both depend on accurate parent grouping.
    const registry = new SubagentRegistry();
    registry.upsert(node("a", "root"));
    registry.upsert(node("b", "root"));
    registry.upsert(node("c", "root", "done"));
    expect(registry.children("root").map((n) => n.sessionId).sort()).toEqual(["a", "b", "c"]);
    expect(registry.runningChildCount("root")).toBe(2);
  });

  it("emits change events on upsert/update/remove", () => {
    // Intent: the widget re-renders by subscribing to change; every mutation must notify.
    const registry = new SubagentRegistry();
    const listener = vi.fn();
    const off = registry.onChange(listener);
    registry.upsert(node("a", "root"));
    registry.update("a", { status: "done" });
    registry.remove("a");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(registry.get("a")).toBeUndefined();
    off();
    registry.upsert(node("b", "root"));
    expect(listener).toHaveBeenCalledTimes(3); // no more calls after unsubscribe
  });

  it("returns copies so external mutation cannot corrupt state", () => {
    // Intent: callers rendering nodes must not be able to flip live status by mutating the returned object.
    const registry = new SubagentRegistry();
    registry.upsert(node("a", "root"));
    const snapshot = registry.get("a")!;
    snapshot.status = "error";
    expect(registry.get("a")!.status).toBe("running");
  });
});

describe("subagent permission host", () => {
  it("returns null when no host is registered", async () => {
    // Intent: headless top-level (no UI host) must return null so the guard can safely block, not allow.
    clearSubagentPermissionHost();
    expect(hasSubagentPermissionHost()).toBe(false);
    await expect(askSubagentPermissionHost({ agentType: "w", depth: 2, prompt: "bash: rm -rf" })).resolves.toBeNull();
  });

  it("forwards to the registered host and clears by identity", async () => {
    // Intent: subagent asks reach the root host; a stale root must not unregister a newer host.
    const hostA = vi.fn(async () => true);
    const hostB = vi.fn(async () => false);
    setSubagentPermissionHost(hostA);
    await expect(askSubagentPermissionHost({ agentType: "w", depth: 2, prompt: "bash: rm -rf" })).resolves.toBe(true);

    setSubagentPermissionHost(hostB);
    clearSubagentPermissionHost(hostA); // hostA is stale; must be a no-op
    expect(hasSubagentPermissionHost()).toBe(true);
    await expect(askSubagentPermissionHost({ agentType: "w", depth: 2, prompt: "bash: rm -rf" })).resolves.toBe(false);

    clearSubagentPermissionHost(hostB);
    expect(hasSubagentPermissionHost()).toBe(false);
  });
});
