import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SubagentConversationViewer } from "../src/task/viewer.js";
import { subagentActivityStore } from "../src/task/activity.js";
import { buildSessionRecord, registerSubagentsCommand } from "../src/task/ui.js";
import { getSubagentSessionDir } from "../src/task/sessions.js";
import type { SubagentSessionRecord } from "../src/task/types.js";
import { createTempWorkspace, createToolRegistry } from "./helpers.js";

function createRecord(manager: SessionManager, currentName: string, summary: string, status: "running" | "completed" | "failed", chain: string[]): SubagentSessionRecord {
  const info = {
    path: manager.getSessionFile()!,
    id: manager.getSessionId(),
    cwd: manager.getCwd(),
    created: new Date(),
    modified: new Date(),
    messageCount: manager.buildSessionContext().messages.length,
    firstMessage: "first",
    allMessagesText: "all",
    parentSessionPath: manager.getHeader()?.parentSession,
    name: currentName,
  };
  return {
    info,
    currentName,
    invocationChain: chain,
    status,
    summary,
    tailLines: [summary],
  };
}

describe("subagent ui helpers", () => {
  it("builds session records from snapshot and live activity data", async () => {
    const workspace = await createTempWorkspace();
    const manager = SessionManager.create(workspace, getSubagentSessionDir(workspace));
    manager.appendSessionInfo("coder");
    manager.appendCustomEntry("pi-base-subagent-invocation", { name: "coder", timestamp: "1" });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Snapshot text" }] } as any);

    const snapshotInfo = {
      path: manager.getSessionFile()!,
      id: manager.getSessionId(),
      cwd: manager.getCwd(),
      created: new Date(),
      modified: new Date(),
      messageCount: 1,
      firstMessage: "first",
      allMessagesText: "all",
      parentSessionPath: manager.getHeader()?.parentSession,
      name: "coder",
    };
    const snapshotRecord = buildSessionRecord(snapshotInfo as any, getSubagentSessionDir(workspace));
    expect(snapshotRecord.currentName).toBe("coder");
    expect(snapshotRecord.summary).toContain("Snapshot text");

    subagentActivityStore.upsert({
      sessionId: snapshotInfo.id,
      sessionFile: snapshotInfo.path,
      mode: "new",
      name: "reviewer",
      status: "running",
      tailLines: ["live"],
      summary: "live",
      currentResponseText: "live",
      activeTools: [],
      session: { messages: manager.buildSessionContext().messages } as any,
    } as any);
    const liveRecord = buildSessionRecord(snapshotInfo as any, getSubagentSessionDir(workspace));
    expect(liveRecord.currentName).toBe("reviewer");
    expect(liveRecord.status).toBe("running");
  });

  it("renders a snapshot conversation viewer and supports scrolling state", async () => {
    const workspace = await createTempWorkspace();
    const manager = SessionManager.create(workspace, getSubagentSessionDir(workspace));
    manager.appendSessionInfo("reviewer");
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "Please review" }] } as any);
    manager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Looking at the diff" },
        { type: "toolCall", name: "read", arguments: { path: "src/app.ts" } },
      ],
    } as any);
    manager.appendMessage({ role: "toolResult", content: [{ type: "text", text: "path: src/app.ts\nkind: file" }] } as any);

    const record = createRecord(manager, "reviewer", "kind: file", "completed", ["coder", "reviewer"]);
    const viewer = new SubagentConversationViewer(
      { terminal: { rows: 40 }, requestRender() {} } as any,
      { fg: (_c: string, text: string) => text, bold: (text: string) => text },
      getSubagentSessionDir(workspace),
      record,
      () => undefined,
    );

    const rendered = viewer.render(100).join("\n");
    expect(rendered).toContain("reviewer");
    expect(rendered).toContain("coder -> reviewer");
    expect(rendered).toContain("User:");
    expect(rendered).toContain("Assistant:");
    expect(rendered).toContain("Tool Call:");
    expect(rendered).toContain("Tool Result:");

    viewer.handleInput("\u001b[B");
    viewer.handleInput("f");
    viewer.dispose();
  });

  it("handles small widths, empty transcripts, navigation keys, and quit", async () => {
    const workspace = await createTempWorkspace();
    const manager = SessionManager.create(workspace, getSubagentSessionDir(workspace));
    const record = createRecord(manager, "idle", "summary", "completed", ["idle"]);
    let closed = false;
    const viewer = new SubagentConversationViewer(
      { terminal: { rows: 20 }, requestRender() {} } as any,
      { fg: (_c: string, text: string) => text, bold: (text: string) => text },
      getSubagentSessionDir(workspace),
      record,
      () => {
        closed = true;
        return undefined;
      },
    );

    expect(viewer.render(10)).toEqual([]);
    const rendered = viewer.render(80).join("\n");
    expect(rendered).toContain("(no conversation yet)");
    viewer.handleInput("\u001b[5~");
    viewer.handleInput("\u001b[6~");
    viewer.handleInput("\u001b[H");
    viewer.handleInput("\u001b[F");
    viewer.handleInput("q");
    expect(closed).toBe(true);
    viewer.dispose();
  });

  it("registers /subagents and enforces bare usage", async () => {
    const registry = createToolRegistry({ hasUI: true });
    registerSubagentsCommand(registry.pi as any);
    await registry.runCommand("subagents", "extra", {});
    expect(registry.getNotifications()).toContainEqual({ message: "Usage: /subagents", variant: "warning" });
  });

  it("notifies when no subagent sessions exist", async () => {
    const workspace = await createTempWorkspace();
    const registry = createToolRegistry({ hasUI: true, cwd: workspace });
    registerSubagentsCommand(registry.pi as any);
    await registry.runCommand("subagents", "", { cwd: workspace });
    expect(registry.getNotifications()[0]?.message).toContain("No subagent sessions found");
  });

  it("returns early for /subagents in non-UI contexts", async () => {
    const workspace = await createTempWorkspace();
    const registry = createToolRegistry({ hasUI: false, cwd: workspace });
    registerSubagentsCommand(registry.pi as any);
    await registry.runCommand("subagents", "", { cwd: workspace });
    expect(registry.getNotifications()).toEqual([]);
  });
});
