import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import piBaseExtension, { type PiBaseNotifyPayload } from "../index.js";
import { registerNotifySupport } from "../src/notify.js";
import { createTempWorkspace, createToolRegistry } from "./helpers.js";

async function writeProjectSettings(root: string, settings: unknown): Promise<void> {
  const settingsDir = join(root, ".pi");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(join(settingsDir, "pi-base.json"), JSON.stringify(settings), "utf8");
}

let previousGlobalSettingsPath: string | undefined;
let previousAgentDir: string | undefined;

beforeEach(async () => {
  previousGlobalSettingsPath = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await createTempWorkspace();
  const globalPath = join(root, "global-pi-base.json");
  await writeFile(globalPath, JSON.stringify({}), "utf8");
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalPath;

  const agentDir = await createTempWorkspace();
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({}), "utf8");
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (previousGlobalSettingsPath === undefined) {
    delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  } else {
    process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
  }
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

describe("notify support", () => {
  it("sends a notification when permission approval is requested", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: { write: "ask" },
      notify: { permissionAsked: true, agentEnd: false },
    });

    const payloads: PiBaseNotifyPayload[] = [];
    const registry = createToolRegistry({ hasUI: true, cwd: root, ui: { select: async () => "Yes" } });
    piBaseExtension(registry.pi as any, {
      notify: {
        sendNotification: async (payload) => {
          payloads.push(payload);
        },
      },
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/notify.ts", content: "export const notify = true;\n" },
      undefined,
      undefined,
      {
        cwd: root,
        sessionManager: {
          getSessionId: () => "session-1",
          getSessionName: () => "Permission Session",
        },
      },
    );

    expect(payloads).toEqual([
      {
        kind: "permission.requested",
        cwd: root,
        projectName: root.split("/").at(-1) ?? root,
        sessionID: "session-1",
        sessionTitle: "Permission Session",
      },
    ]);
  });

  it("stays disabled when notify config is omitted", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: { write: "ask" },
    });

    const payloads: PiBaseNotifyPayload[] = [];
    const registry = createToolRegistry({ hasUI: true, cwd: root, ui: { select: async () => "Yes" } });
    piBaseExtension(registry.pi as any, {
      notify: {
        sendNotification: async (payload) => {
          payloads.push(payload);
        },
      },
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/no-notify.ts", content: "export const silent = true;\n" },
      undefined,
      undefined,
      {
        cwd: root,
        sessionManager: {
          getSessionId: () => "session-0",
          getSessionName: () => "Silent Session",
        },
      },
    );

    await registry.emit("agent_end", { type: "agent_end", messages: [] }, {
      cwd: root,
      sessionManager: {
        getSessionId: () => "session-0",
        getSessionName: () => "Silent Session",
      },
    });

    expect(payloads).toEqual([]);
  });

  it("still sends a completion notification in yolo mode when the agent stops", async () => {
    // Intent: yolo removes permission prompts, so permission.requested never fires,
    // but when the agent actually stops the user still needs a desktop ping to come back.
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      yolo: true,
      notify: { permissionAsked: true, agentEnd: true },
    });

    const payloads: PiBaseNotifyPayload[] = [];
    const registry = createToolRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      notify: {
        sendNotification: async (payload) => {
          payloads.push(payload);
        },
      },
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    await registry.emit("agent_end", { type: "agent_end", messages: [] }, {
      cwd: root,
      sessionManager: {
        getSessionId: () => "session-yolo",
        getSessionName: () => "Yolo Session",
      },
    });

    expect(payloads).toEqual([{
      kind: "session.completed",
      cwd: root,
      projectName: root.split("/").at(-1) ?? root,
      sessionID: "session-yolo",
      sessionTitle: "Yolo Session",
    }]);
  });

  it("uses the runtime /yolo toggle without suppressing final stop notifications", async () => {
    // Intent: /yolo should keep bypassing permission asks, but once the agent really
    // stops it should still notify so the user knows to come back.
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      notify: { agentEnd: true },
    });

    const payloads: PiBaseNotifyPayload[] = [];
    const registry = createToolRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      notify: {
        sendNotification: async (payload) => {
          payloads.push(payload);
        },
      },
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const sessionCtx = {
      cwd: root,
      sessionManager: {
        getSessionId: () => "session-runtime-yolo",
        getSessionName: () => "Runtime Yolo Session",
      },
    };

    await registry.runCommand("yolo", "", { cwd: root });
    await registry.emit("agent_end", { type: "agent_end", messages: [] }, sessionCtx);
    await registry.runCommand("yolo", "", { cwd: root });
    await registry.emit("agent_end", { type: "agent_end", messages: [] }, sessionCtx);
    expect(payloads).toEqual([
      {
        kind: "session.completed",
        cwd: root,
        projectName: root.split("/").at(-1) ?? root,
        sessionID: "session-runtime-yolo",
        sessionTitle: "Runtime Yolo Session",
      },
      {
        kind: "session.completed",
        cwd: root,
        projectName: root.split("/").at(-1) ?? root,
        sessionID: "session-runtime-yolo",
        sessionTitle: "Runtime Yolo Session",
      },
    ]);
  });

  it("does not notify on intermediate retryable errors that will auto-retry", async () => {
    // Intent: notification should mean "come back now", so transient retryable errors
    // must stay silent until the retry budget is actually exhausted.
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      notify: { agentEnd: true },
    });

    const payloads: PiBaseNotifyPayload[] = [];
    const registry = createToolRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      notify: {
        sendNotification: async (payload) => {
          payloads.push(payload);
        },
      },
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    await registry.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 429 overloaded", timestamp: 2 }],
    }, {
      cwd: root,
      sessionManager: {
        getSessionId: () => "session-retrying",
        getSessionName: () => "Retrying Session",
        getEntries: () => [{ type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 429 overloaded", timestamp: 1 } }],
      },
    });

    expect(payloads).toEqual([]);
  });

  it("sends an error notification when the retry budget is exhausted", async () => {
    // Intent: once transient failures stop auto-retrying, the user should get the same
    // stop notification as a normal completion.
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      notify: { agentEnd: true },
    });

    const payloads: PiBaseNotifyPayload[] = [];
    const registry = createToolRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      notify: {
        sendNotification: async (payload) => {
          payloads.push(payload);
        },
      },
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    await registry.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 429 overloaded", timestamp: 4 }],
    }, {
      cwd: root,
      sessionManager: {
        getSessionId: () => "session-error",
        getSessionName: () => "Error Session",
        getEntries: () => [
          { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 429 overloaded", timestamp: 1 } },
          { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 429 overloaded", timestamp: 2 } },
          { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 429 overloaded", timestamp: 3 } },
        ],
      },
    });

    expect(payloads).toEqual([{
      kind: "session.error",
      cwd: root,
      projectName: root.split("/").at(-1) ?? root,
      sessionID: "session-error",
      sessionTitle: "Error Session",
    }]);
  });

  it("skips the stop notification when the last assistant message was aborted", async () => {
    // Intent: if we can tell the stop came from a user abort, avoid a redundant desktop ping.
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      notify: { agentEnd: true },
    });

    const payloads: PiBaseNotifyPayload[] = [];
    const registry = createToolRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      notify: {
        sendNotification: async (payload) => {
          payloads.push(payload);
        },
      },
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    await registry.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "aborted" }],
    }, {
      cwd: root,
      sessionManager: {
        getSessionId: () => "session-aborted",
        getSessionName: () => "Aborted Session",
      },
    });

    expect(payloads).toEqual([]);
  });

  it("sends a completion notification on agent_end and suppresses it after permission rejection", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: { write: "ask" },
      notify: { permissionAsked: true, agentEnd: true },
    });

    const payloads: PiBaseNotifyPayload[] = [];
    const registry = createToolRegistry({ hasUI: true, cwd: root, ui: { select: async () => "No" } });
    piBaseExtension(registry.pi as any, {
      notify: {
        sendNotification: async (payload) => {
          payloads.push(payload);
        },
      },
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/reject.ts", content: "export const reject = true;\n" },
      undefined,
      undefined,
      {
        cwd: root,
        sessionManager: {
          getSessionId: () => "session-2",
          getSessionName: () => "Rejected Session",
        },
      },
    );

    await registry.emit("agent_end", { type: "agent_end", messages: [] }, {
      cwd: root,
      sessionManager: {
        getSessionId: () => "session-2",
        getSessionName: () => "Rejected Session",
      },
    });

    expect(payloads).toEqual([
      {
        kind: "permission.requested",
        cwd: root,
        projectName: root.split("/").at(-1) ?? root,
        sessionID: "session-2",
        sessionTitle: "Rejected Session",
      },
    ]);

    await registry.emit("agent_end", { type: "agent_end", messages: [] }, {
      cwd: root,
      sessionManager: {
        getSessionId: () => "session-3",
        getSessionName: () => "Completed Session",
      },
    });

    expect(payloads.at(-1)).toEqual({
      kind: "session.completed",
      cwd: root,
      projectName: root.split("/").at(-1) ?? root,
      sessionID: "session-3",
      sessionTitle: "Completed Session",
    });
  });

  it("collapses multiple permission asks in the same turn into one notification", async () => {
    // Intent: when the model returns several tool calls at once (e.g. 5 edits),
    // permission prompts are serialized but should alert the user only once per
    // model round. A new turn_start resets the marker so the next round alerts again.
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: { write: "ask" },
      notify: { permissionAsked: true, agentEnd: false },
    });

    const payloads: PiBaseNotifyPayload[] = [];
    const registry = createToolRegistry({ hasUI: true, cwd: root, ui: { select: async () => "Yes" } });
    piBaseExtension(registry.pi as any, {
      notify: {
        sendNotification: async (payload) => {
          payloads.push(payload);
        },
      },
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const sessionCtx = {
      cwd: root,
      sessionManager: {
        getSessionId: () => "session-turn",
        getSessionName: () => "Turn Session",
      },
    };
    const runWrite = async (id: string, path: string) =>
      registry.getTool("write").execute(id, { workdir: ".", path, content: "export const x = true;\n" }, undefined, undefined, sessionCtx);

    // First turn: two asks, only the first notifies.
    await runWrite("1", "src/a.ts");
    await runWrite("2", "src/b.ts");
    expect(payloads).toHaveLength(1);

    // A new turn resets the marker, so the next ask notifies again.
    await registry.emit("turn_start", { type: "turn_start" }, sessionCtx);
    await runWrite("3", "src/c.ts");
    expect(payloads).toHaveLength(2);
    expect(payloads.every((payload) => payload.kind === "permission.requested" && payload.sessionID === "session-turn")).toBe(true);
  });

  it("does not throw when registered without loadSettings", async () => {
    // Intent: notify support is an exported helper; omitting loadSettings should
    // make notifications a no-op instead of throwing through optional chaining.
    const registry = createToolRegistry({ hasUI: true });
    const hooks = registerNotifySupport(registry.pi as any);

    await expect(registry.emit("agent_end", { type: "agent_end", messages: [] }, {})).resolves.toBeUndefined();
    await expect(hooks.onPermissionAsked({ ctx: {} as any })).resolves.toBeUndefined();
    expect(() => hooks.onPermissionRejected({ ctx: {} as any })).not.toThrow();
  });
});
