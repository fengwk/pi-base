import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerRuntimeDiagnosticHost,
  reportRuntimeError,
  reportRuntimeWarning,
} from "../src/runtime-diagnostics.js";
import { DEPTH_ENTRY, ROOT_SESSION_ENTRY, rootSessionEntryData } from "../src/subagent/depth.js";

function createContext(hasUI: boolean, depth?: number, rootSessionId = "root-session") {
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  if (depth !== undefined) {
    entries.push({ type: "custom", customType: DEPTH_ENTRY, data: { depth } });
    entries.push({ type: "custom", customType: ROOT_SESSION_ENTRY, data: rootSessionEntryData(rootSessionId) });
  }
  const notify = vi.fn();
  return {
    ctx: {
      hasUI,
      sessionManager: {
        getEntries: () => entries,
        getSessionId: () => depth === undefined ? rootSessionId : "child-session",
      },
      ui: { notify },
    } as never,
    notify,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runtime diagnostics", () => {
  it("routes interactive warnings and errors through Pi's managed UI", () => {
    // Managed notifications trigger a TUI render instead of writing at the editor cursor.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { ctx, notify } = createContext(true);

    reportRuntimeWarning(ctx, "visible warning", "stderr warning");
    reportRuntimeError(ctx, "visible error", "stderr error", new Error("details"));

    expect(notify).toHaveBeenNthCalledWith(1, "visible warning", "warning");
    expect(notify).toHaveBeenNthCalledWith(2, "visible error", "error");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps stderr diagnostics for a top-level headless session", () => {
    // Print/JSON callers own stderr, so diagnostics must remain observable without a UI.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const details = new Error("details");
    const { ctx, notify } = createContext(false);

    reportRuntimeWarning(ctx, "visible warning", "stderr warning");
    reportRuntimeError(ctx, "visible error", "stderr error", details);

    expect(notify).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("stderr warning");
    expect(error).toHaveBeenCalledWith("stderr error", details);
  });

  it("suppresses raw process output from an in-process headless subagent", () => {
    // Without a live root host, a stale child must stay silent rather than corrupt an unknown TUI.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { ctx, notify } = createContext(false, 2);

    reportRuntimeWarning(ctx, "visible warning", "stderr warning");
    reportRuntimeError(ctx, "visible error", "stderr error", new Error("details"));

    expect(notify).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("relays headless subagent diagnostics through the root session host", () => {
    // A live child must preserve diagnostics without writing directly to the shared process stderr.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = createContext(true, undefined, "relay-root");
    const child = createContext(false, 2, "relay-root");
    const dispose = registerRuntimeDiagnosticHost(root.ctx);

    try {
      reportRuntimeWarning(child.ctx, "child warning", "child stderr warning");
      reportRuntimeError(child.ctx, "child error", "child stderr error", new Error("details"));

      expect(root.notify).toHaveBeenNthCalledWith(1, "child warning", "warning");
      expect(root.notify).toHaveBeenNthCalledWith(2, "child error", "error");
      expect(child.notify).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("relays child diagnostics to top-level stderr when the root is headless", () => {
    // A print/JSON root has no TUI to corrupt and remains the owner of observable stderr output.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = createContext(false, undefined, "headless-root");
    const child = createContext(false, 2, "headless-root");
    const details = new Error("details");
    const dispose = registerRuntimeDiagnosticHost(root.ctx);

    try {
      reportRuntimeWarning(child.ctx, "child warning", "child stderr warning");
      reportRuntimeError(child.ctx, "child error", "child stderr error", details);

      expect(root.notify).not.toHaveBeenCalled();
      expect(child.notify).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("child stderr warning");
      expect(error).toHaveBeenCalledWith("child stderr error", details);
    } finally {
      dispose();
    }
  });
});
