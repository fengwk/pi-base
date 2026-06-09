import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendSubagentInvocation, collapseInvocationChain, createSubagentSessionManager, deriveSubagentSessionDir, findSubagentSessionInfo, getLatestSubagentInvocation, getSubagentSessionDir, getSubagentSessionsRoot, listSubagentSessions, openSubagentSessionManager, readSubagentInvocations } from "../src/subagent/sessions.js";
import { createTempWorkspace } from "./helpers.js";

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

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("subagent session helpers", () => {
  it("stores child sessions in a sibling sessions-subagents directory", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      const root = getSubagentSessionsRoot(agentDir);
      const dir = getSubagentSessionDir(workspace, agentDir);

      expect(root).toBe(`${agentDir}/sessions-subagents`);
      expect(dir.startsWith(root)).toBe(true);
      expect(dir).toContain("--");
    });
  });
  it("derives a sibling directory from the current parent session directory", async () => {
    const workspace = await createTempWorkspace();
    const encodedParentDir = "/tmp/pi/sessions/--repo-workspace--";
    expect(deriveSubagentSessionDir(workspace, encodedParentDir)).toBe("/tmp/pi/sessions-subagents/--repo-workspace--");
    expect(deriveSubagentSessionDir(workspace, "/tmp/custom-sessions")).toBe("/tmp/custom-sessions-subagents");
  });
  it("covers the default no-parent helper paths", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      const dir = getSubagentSessionDir(workspace, agentDir);
      expect(dir).toBe(deriveSubagentSessionDir(workspace, undefined, agentDir));
      const manager = createSubagentSessionManager(workspace, undefined, agentDir);
      expect(manager.getHeader()?.parentSession).toBeUndefined();
      appendSubagentInvocation(manager, { name: "solo", timestamp: "1" });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }] } as any);
      expect(readSubagentInvocations(manager.getEntries())).toEqual([{ name: "solo", timestamp: "1", parentSessionId: undefined, callerSessionId: undefined }]);
      const listed = await listSubagentSessions(workspace, agentDir);
      expect(listed.some((info) => info.id === manager.getSessionId())).toBe(true);
    });
  });

  it("creates, lists, opens, and links subagent sessions", async () => {
    await withTempAgentDir(async (agentDir) => {
      const workspace = await createTempWorkspace();
      const parent = SessionManager.create(workspace);
      parent.appendMessage({ role: "user", content: [{ type: "text", text: "root" }] } as any);

      const manager = createSubagentSessionManager(workspace, parent.getSessionFile(), agentDir, parent.getSessionDir());
      appendSubagentInvocation(manager, { name: "coder", timestamp: new Date().toISOString() });
      manager.appendMessage({ role: "user", content: [{ type: "text", text: "child task" }] } as any);
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }] } as any);

      const sessions = await listSubagentSessions(workspace, agentDir, parent.getSessionDir());
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.parentSessionPath).toBe(parent.getSessionFile());

      const info = await findSubagentSessionInfo(workspace, manager.getSessionId(), agentDir, parent.getSessionDir());
      expect(info?.id).toBe(manager.getSessionId());

      const reopened = await openSubagentSessionManager(workspace, manager.getSessionId(), agentDir, parent.getSessionDir());
      const entries = reopened.getEntries();
      expect(getLatestSubagentInvocation(entries)?.name).toBe("coder");
      expect(collapseInvocationChain(entries)).toEqual(["coder"]);
      expect(reopened.buildSessionContext().messages).toHaveLength(2);
    });
  });

  it("collapses repeated invocation names while preserving handoffs", async () => {
    const workspace = await createTempWorkspace();
    const manager = SessionManager.inMemory(workspace);
    manager.appendCustomEntry("pi-base-subagent-invocation", { name: "coder", timestamp: "1" });
    manager.appendCustomEntry("pi-base-subagent-invocation", { name: "coder", timestamp: "2" });
    manager.appendCustomEntry("pi-base-subagent-invocation", { name: "reviewer", timestamp: "3" });
    manager.appendCustomEntry("pi-base-subagent-invocation", { name: "reviewer", timestamp: "4" });

    expect(collapseInvocationChain(manager.getEntries())).toEqual(["coder", "reviewer"]);
  });
});
