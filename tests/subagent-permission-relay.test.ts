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
        title: "⟳ subagent「worker」(depth 2) requests permission: Permission request",
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
    // Intent: cancellation must dismiss the root-owned selector and release both the headless
    // subagent and the serialized host chain, so a later permission request can be shown.
    let markSelectStarted!: () => void;
    const selectStarted = new Promise<void>((resolve) => {
      markSelectStarted = resolve;
    });
    let selectCalls = 0;
    const registry = createToolRegistry({
      hasUI: true,
      cwd: "/tmp/root-project",
      ui: {
        select: async (_title, _items, options) => {
          selectCalls += 1;
          if (selectCalls > 1) return "Yes";
          markSelectStarted();
          return new Promise<string>((_resolve, reject) => {
            const signal = options?.signal;
            const abort = () => reject(new Error("selector aborted"));
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
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
    await selectStarted;
    controller.abort();

    await expect(decision).rejects.toMatchObject({ message: "Operation aborted" });
    await expect(askSubagentPermissionHost({
      agentType: "worker",
      depth: 2,
      rootSessionId: "root-session-abort",
      prompt: "Next permission request",
    })).resolves.toBe(true);
    expect(selectCalls).toBe(2);
  });

  it("preserves a subagent host selector error when its signal is not aborted", async () => {
    // Intent: host error normalization is limited to actual cancellation and must not hide a real
    // root UI failure behind the generic abort error.
    const uiError = new Error("root selector failed");
    const registry = createToolRegistry({
      hasUI: true,
      cwd: "/tmp/root-project",
      ui: {
        select: async () => {
          throw uiError;
        },
      },
    });
    piBaseExtension(registry.pi as any);
    const rootCtx = {
      cwd: "/tmp/root-project",
      hasUI: true,
      sessionManager: {
        getSessionId: () => "root-session-ui-error",
        getEntries: () => [],
      },
    };
    await registry.emit("session_start", { reason: "startup" }, rootCtx);
    const controller = new AbortController();

    const decision = askSubagentPermissionHost({
      agentType: "worker",
      depth: 2,
      rootSessionId: "root-session-ui-error",
      prompt: "Permission request",
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(false);
    await expect(decision).rejects.toBe(uiError);
    await registry.emit("session_shutdown", { reason: "quit" }, rootCtx);
  });
});
