import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SubagentConversationViewer } from "../src/subagent/viewer.js";
import { subagentActivityStore } from "../src/subagent/activity.js";
import { buildSessionRecord, buildSubagentTree, flattenSubagentTree, registerSubagentsCommand } from "../src/subagent/ui.js";
import { getSubagentSessionDir } from "../src/subagent/sessions.js";
import type { SubagentSessionRecord } from "../src/subagent/types.js";
import { createTempWorkspace, createToolRegistry } from "./helpers.js";

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await createTempWorkspace();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

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
  it("builds and flattens a parent-child session tree", async () => {
    const workspace = await createTempWorkspace();
    const parent = SessionManager.create(workspace);
    parent.appendMessage({ role: "user", content: [{ type: "text", text: "root" }] } as any);

    const child = SessionManager.create(workspace);
    child.newSession({ parentSession: parent.getSessionFile() });
    child.appendMessage({ role: "user", content: [{ type: "text", text: "child" }] } as any);

    const grandchild = SessionManager.create(workspace);
    grandchild.newSession({ parentSession: child.getSessionFile() });
    grandchild.appendMessage({ role: "user", content: [{ type: "text", text: "grand" }] } as any);

    const nodes = buildSubagentTree([
      createRecord(child, "coder", "child summary", "completed", ["coder"]),
      createRecord(grandchild, "reviewer", "grand summary", "running", ["coder", "reviewer"]),
    ], parent.getSessionFile());
    const flat = flattenSubagentTree(nodes);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.children).toHaveLength(1);
    expect(flat.map((entry) => entry.node.record.currentName)).toEqual(["coder", "reviewer"]);
    expect(flat.map((entry) => entry.depth)).toEqual([0, 1]);
  });
  it("keeps orphaned records only when no parent session filter is provided", async () => {
    const workspace = await createTempWorkspace();
    const orphan = SessionManager.create(workspace);
    orphan.appendMessage({ role: "user", content: [{ type: "text", text: "orphan" }] } as any);

    const filtered = buildSubagentTree([createRecord(orphan, "solo", "summary", "completed", ["solo"])], "/tmp/other.jsonl");
    const unfiltered = buildSubagentTree([createRecord(orphan, "solo", "summary", "completed", ["solo"]) ]);

    expect(filtered).toEqual([]);
    expect(unfiltered).toHaveLength(1);
  });
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
    expect(rendered).toContain("[User]");
    expect(rendered).toContain("[Assistant]");
    expect(rendered).toContain("[Tool] read");
    expect(rendered).toContain("[Result]");

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
    await registry.runCommand("subagents", "", { cwd: workspace, hasUI: false });
    expect(registry.getNotifications()).toEqual([]);
  });

  it("renders picker and conversation viewer overlays when sessions exist", async () => {
    await withTempAgentDir(async () => {
      const workspace = await createTempWorkspace();
      const manager = SessionManager.create(workspace, getSubagentSessionDir(workspace));
      manager.appendSessionInfo("coder");
      manager.appendCustomEntry("pi-base-subagent-invocation", { name: "coder", timestamp: "1" });
      manager.appendMessage({ role: "user", content: [{ type: "text", text: "Do work" }] } as any);
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done" }] } as any);

      const registry = createToolRegistry({ hasUI: true, cwd: workspace });
      const overlayRenders: string[] = [];
      let call = 0;
      registry.setUI({
        custom: async (factory) => {
          call += 1;
          const doneValues: any[] = [];
          const component = factory(
            { terminal: { rows: 40 }, requestRender() {} },
            { fg: (_c: string, text: string) => text, bold: (text: string) => text },
            undefined,
            (value: any) => {
              doneValues.push(value);
              return undefined;
            },
          );
          overlayRenders.push(component.render(100).join("\n"));
          if (call === 1) {
            component.handleInput("\r");
            return doneValues[0];
          }
          component.handleInput("q");
          return undefined;
        },
      });

      registerSubagentsCommand(registry.pi as any);
      await registry.runCommand("subagents", "", { cwd: workspace, hasUI: true });
      expect(call).toBe(2);
      expect(overlayRenders[0]).toContain("Subagents");
      expect(overlayRenders[1]).toContain("coder");
      expect(overlayRenders[1]).toContain("[User]");
    });
  });


  it("uses live activity when available for viewer rendering", async () => {
    const workspace = await createTempWorkspace();
    const manager = SessionManager.create(workspace, getSubagentSessionDir(workspace));
    manager.appendSessionInfo("coder");
    const record = createRecord(manager, "coder", "running", "running", ["coder"]);
    subagentActivityStore.upsert({
      sessionId: record.info.id,
      sessionFile: record.info.path,
      mode: "new",
      name: "coder",
      status: "running",
      tailLines: ["live tail"],
      summary: "live tail",
      updatedAt: Date.now(),
      currentResponseText: "Streaming live response",
      activeTools: ["read"],
      parentSessionPath: undefined,
    } as any);

    const viewer = new SubagentConversationViewer(
      { terminal: { rows: 40 }, requestRender() {} } as any,
      { fg: (_c: string, text: string) => text, bold: (text: string) => text },
      getSubagentSessionDir(workspace),
      record,
      () => undefined,
    );
    const rendered = viewer.render(100).join("\n");
    expect(rendered).toContain("[Assistant…]");
    expect(rendered).toContain("[Running] read");
    viewer.dispose();
    subagentActivityStore.clear();
  });
});
