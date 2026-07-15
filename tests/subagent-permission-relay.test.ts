import { afterEach, describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import {
  askSubagentPermissionHost,
  clearSubagentPermissionHost,
  hasSubagentPermissionHost,
} from "../src/subagent/permission-host.js";
import { createToolRegistry } from "./helpers.js";

afterEach(() => {
  clearSubagentPermissionHost();
});

describe("subagent permission relay", () => {
  it("uses the same Yes/No actions as the normal permission prompt", async () => {
    // Intent: root-mediated subagent asks should match the main permission UI
    // so users do not have to relearn button semantics.
    const prompts: Array<{ title: string; items: string[] }> = [];
    const registry = createToolRegistry({
      hasUI: true,
      cwd: "/tmp/root-project",
      ui: {
        select: async (title, items) => {
          prompts.push({ title, items });
          return "Yes";
        },
      },
    });
    piBaseExtension(registry.pi as any);

    await registry.emit("session_start", { reason: "startup" }, {
      cwd: "/tmp/root-project",
      hasUI: true,
      sessionManager: {
        getSessionId: () => "root-session",
        getEntries: () => [],
      },
    });

    const allowed = await askSubagentPermissionHost({
      agentType: "worker",
      depth: 2,
      rootSessionId: "root-session",
      prompt: "Permission request",
    });

    expect(allowed).toBe(true);
    expect(prompts).toEqual([
      {
        title: "⟳ subagent「worker」(depth 2) requests permission\n\nPermission request",
        items: ["Yes", "No"],
      },
    ]);
  });

  it("replaces the previous root host on repeated session starts", async () => {
    // Intent: session switches/reloads must not leave an old root id routed to a stale UI context.
    const registry = createToolRegistry({ hasUI: true, cwd: "/tmp/root-project" });
    piBaseExtension(registry.pi as any);
    const rootContext = (sessionId: string) => ({
      cwd: "/tmp/root-project",
      hasUI: true,
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => [],
      },
    });

    await registry.emit("session_start", { reason: "startup" }, rootContext("first-root"));
    expect(hasSubagentPermissionHost("first-root")).toBe(true);

    await registry.emit("session_start", { reason: "switch" }, rootContext("second-root"));

    expect(hasSubagentPermissionHost("first-root")).toBe(false);
    expect(hasSubagentPermissionHost("second-root")).toBe(true);

    await registry.emit("session_shutdown", { reason: "switch" }, rootContext("first-root"));
    expect(hasSubagentPermissionHost("second-root")).toBe(true);

    await registry.emit("session_shutdown", { reason: "quit" }, rootContext("second-root"));
    expect(hasSubagentPermissionHost("second-root")).toBe(false);
  });

  it("discards an old root decision that resolves after the host is replaced", async () => {
    // Intent: a stale UI returning Yes after a session switch must not authorize the old request.
    let markSelectStarted!: () => void;
    const selectStarted = new Promise<void>((resolve) => {
      markSelectStarted = resolve;
    });
    let finishSelect!: (choice: string) => void;
    const registry = createToolRegistry({
      hasUI: true,
      cwd: "/tmp/root-project",
      ui: {
        select: async () => {
          markSelectStarted();
          return new Promise<string>((resolve) => {
            finishSelect = resolve;
          });
        },
      },
    });
    piBaseExtension(registry.pi as any);
    const rootContext = (sessionId: string) => ({
      cwd: "/tmp/root-project",
      hasUI: true,
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => [],
      },
    });
    await registry.emit("session_start", { reason: "startup" }, rootContext("old-root"));
    const oldDecision = askSubagentPermissionHost({
      agentType: "worker",
      depth: 2,
      rootSessionId: "old-root",
      prompt: "Permission request",
    });
    await selectStarted;

    await registry.emit("session_start", { reason: "switch" }, rootContext("new-root"));
    finishSelect("Yes");

    await expect(oldDecision).rejects.toThrow("Subagent permission host is no longer active");
    expect(hasSubagentPermissionHost("old-root")).toBe(false);
    expect(hasSubagentPermissionHost("new-root")).toBe(true);
    await registry.emit("session_shutdown", { reason: "quit" }, rootContext("new-root"));
  });

  it("stops waiting for the root permission UI when the subagent request is aborted", async () => {
    // Intent: cancellation must release the headless subagent promptly even if its root-owned
    // permission selector is still open; the queued UI work can settle independently afterward.
    let markSelectStarted!: () => void;
    const selectStarted = new Promise<void>((resolve) => {
      markSelectStarted = resolve;
    });
    let finishSelect!: (choice: string) => void;
    const registry = createToolRegistry({
      hasUI: true,
      cwd: "/tmp/root-project",
      ui: {
        select: async () => {
          markSelectStarted();
          return new Promise<string>((resolve) => {
            finishSelect = resolve;
          });
        },
      },
    });
    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { reason: "startup" }, {
      cwd: "/tmp/root-project",
      hasUI: true,
      sessionManager: {
        getSessionId: () => "root-session-abort",
        getEntries: () => [],
      },
    });

    const controller = new AbortController();
    const decision = askSubagentPermissionHost({
      agentType: "worker",
      depth: 2,
      rootSessionId: "root-session-abort",
      prompt: "Permission request",
      signal: controller.signal,
    });
    const observed = decision.then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );
    await selectStarted;
    controller.abort();

    try {
      const outcome = await Promise.race([
        observed,
        new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 50)),
      ]);
      expect(outcome).toBe("Operation aborted");
    } finally {
      finishSelect("Yes");
      await decision.catch(() => undefined);
    }
  });
});
