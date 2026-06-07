import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import piBaseExtension, { type PiBaseNotifyPayload } from "../index.js";
import { createTempWorkspace, createToolRegistry } from "./helpers.js";

async function writeProjectSettings(root: string, settings: unknown): Promise<void> {
  const settingsDir = join(root, ".pi");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(join(settingsDir, "pi-base.json"), JSON.stringify(settings), "utf8");
}

let previousGlobalSettingsPath: string | undefined;

beforeEach(async () => {
  previousGlobalSettingsPath = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  const root = await createTempWorkspace();
  const globalPath = join(root, "global-pi-base.json");
  await writeFile(globalPath, JSON.stringify({}), "utf8");
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalPath;
});

afterEach(() => {
  if (previousGlobalSettingsPath === undefined) {
    delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  } else {
    process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
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
});
