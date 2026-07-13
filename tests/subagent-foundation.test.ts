import { describe, expect, it, vi } from "vitest";
import { DEPTH_ENTRY, ROOT_DEPTH, ROOT_SESSION_ENTRY, depthEntryData, isRootSession, readDepth, readRootSessionId, rootSessionEntryData } from "../src/subagent/depth.js";
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

function ctxWithEntries(entries: Entry[], sessionId = "root-session"): { sessionManager: { getEntries: () => Entry[]; getSessionId: () => string } } {
  return { sessionManager: { getEntries: () => entries, getSessionId: () => sessionId } };
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

  it("defaults the root session id to the current session and restores persisted child roots", () => {
    const rootCtx = ctxWithEntries([], "root-1");
    expect(readRootSessionId(rootCtx as never)).toBe("root-1");

    const childCtx = ctxWithEntries([
      { type: "custom", customType: ROOT_SESSION_ENTRY, data: rootSessionEntryData("root-2") },
      { type: "custom", customType: ROOT_SESSION_ENTRY, data: rootSessionEntryData("root-3") },
    ], "child-1");
    expect(readRootSessionId(childCtx as never)).toBe("root-3");
  });

  it("ignores malformed root-session entries", () => {
    const ctx = ctxWithEntries([{ type: "custom", customType: ROOT_SESSION_ENTRY, data: { rootSessionId: 42 } }], "root-4");
    expect(readRootSessionId(ctx as never)).toBe("root-4");
  });
});

describe("SubagentRegistry", () => {
  const node = (id: string, parent: string, status: SubagentNode["status"] = "running"): SubagentNode => ({
    sessionId: id,
    parentSessionId: parent,
    rootSessionId: "root",
    agentType: "worker",
    depth: 2,
    status,
    turns: 0,
    toolCount: 0,
    startedAt: 0,
  });

  it("tracks nodes, children, and running counts", () => {
    // Intent: the tree view and concurrency guard both depend on accurate parent grouping.
    const registry = new SubagentRegistry();
    registry.upsert(node("a", "root"));
    registry.upsert(node("b", "root"));
    registry.upsert(node("c", "root", "done"));
    registry.upsert({ ...node("d", "other-parent"), rootSessionId: "other-root" });
    expect(registry.children("root").map((n) => n.sessionId).sort()).toEqual(["a", "b", "c"]);
    expect(registry.runningChildCount("root")).toBe(2);
    expect(registry.runningCountForRoot("root")).toBe(2);
    expect(registry.runningCountForRoot("other-root")).toBe(1);
  });

  it("filters snapshots by root session", () => {
    const registry = new SubagentRegistry();
    registry.upsert(node("a", "root-a"));
    registry.upsert({ ...node("b", "root-b"), rootSessionId: "other-root" });
    expect(registry.forRoot("root").map((n) => n.sessionId)).toEqual(["a"]);
    expect(registry.forRoot("other-root").map((n) => n.sessionId)).toEqual(["b"]);
  });

  it("removes one root snapshot without affecting other roots", () => {
    // Intent: root teardown should release its tree snapshot without clearing concurrent roots.
    const registry = new SubagentRegistry();
    const listener = vi.fn();
    registry.upsert(node("a", "root"));
    registry.upsert(node("b", "a", "done"));
    registry.upsert({ ...node("foreign", "other-parent"), rootSessionId: "other-root" });
    const off = registry.onChange(listener);

    registry.removeForRoot("root");

    expect(registry.forRoot("root")).toEqual([]);
    expect(registry.forRoot("other-root").map((entry) => entry.sessionId)).toEqual(["foreign"]);
    expect(listener).toHaveBeenCalledTimes(1);
    registry.removeForRoot("missing");
    expect(listener).toHaveBeenCalledTimes(1);
    off();
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
    await expect(askSubagentPermissionHost({ agentType: "w", depth: 2, rootSessionId: "root-a", prompt: "bash: rm -rf" })).resolves.toBeNull();
  });

  it("forwards to the registered root host and clears by identity", async () => {
    // Intent: subagent asks must reach only their owning root host; a stale root must not unregister a newer host.
    const hostA = vi.fn(async () => true);
    const hostB = vi.fn(async () => false);
    setSubagentPermissionHost("root-a", hostA);
    await expect(askSubagentPermissionHost({ agentType: "w", depth: 2, rootSessionId: "root-a", prompt: "bash: rm -rf" })).resolves.toBe(true);
    await expect(askSubagentPermissionHost({ agentType: "w", depth: 2, rootSessionId: "root-b", prompt: "bash: rm -rf" })).resolves.toBeNull();

    setSubagentPermissionHost("root-a", hostB);
    clearSubagentPermissionHost("root-a", hostA); // hostA is stale; must be a no-op
    expect(hasSubagentPermissionHost("root-a")).toBe(true);
    await expect(askSubagentPermissionHost({ agentType: "w", depth: 2, rootSessionId: "root-a", prompt: "bash: rm -rf" })).resolves.toBe(false);

    clearSubagentPermissionHost("root-a", hostB);
    expect(hasSubagentPermissionHost("root-a")).toBe(false);
  });
});
