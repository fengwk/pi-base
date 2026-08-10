import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPersistedSubagentView, subagentSessionDir } from "../src/subagent/runner.js";

const trackedFs = vi.hoisted(() => ({
  jsonlReads: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]).endsWith(".jsonl")) trackedFs.jsonlReads.push(String(args[0]));
      return Reflect.apply(actual.readFileSync, actual, args);
    },
  };
});

const tempRoots: string[] = [];
let previousAgentDir: string | undefined;

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-base-subagent-view-"));
  tempRoots.push(root);
  return root;
}

async function createPersistedSession(
  cwd: string,
  sessionId: string,
  sessionDir = subagentSessionDir(cwd),
): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  const session = SessionManager.create(cwd, sessionDir, { id: sessionId });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `report from ${sessionId}` }],
    provider: "provider",
    model: "model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    stopReason: "stop",
  } as never);
}

function legacySessionDir(agentDir: string, cwd: string): string {
  const safePath = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "subagent-sessions", safePath);
}

function expectOnlySessionRead(sessionId: string): void {
  expect(trackedFs.jsonlReads).toHaveLength(1);
  expect(basename(trackedFs.jsonlReads[0] ?? "").endsWith(`_${sessionId}.jsonl`)).toBe(true);
}

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  trackedFs.jsonlReads.length = 0;
});

afterEach(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  trackedFs.jsonlReads.length = 0;
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("getPersistedSubagentView", () => {
  it("selects by file name before parsing persisted transcripts", async () => {
    // Intent: exact and prefix lookup must parse at most the selected transcript, so lookup cost
    // does not grow with the total byte size of unrelated subagent history.
    const agentDir = await createTempRoot();
    const cwd = await createTempRoot();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    for (const sessionId of [
      "exact-target",
      "unique-target",
      "shared-prefix-a",
      "shared-prefix-b",
      "unrelated-session",
    ]) {
      await createPersistedSession(cwd, sessionId);
    }

    trackedFs.jsonlReads.length = 0;
    expect(getPersistedSubagentView(cwd, "exact-target")).toMatchObject({ sessionId: "exact-target" });
    expectOnlySessionRead("exact-target");

    trackedFs.jsonlReads.length = 0;
    expect(getPersistedSubagentView(cwd, "unique")).toMatchObject({ sessionId: "unique-target" });
    expectOnlySessionRead("unique-target");

    trackedFs.jsonlReads.length = 0;
    expect(getPersistedSubagentView(cwd, "shared-prefix")).toBe("ambiguous");
    expect(trackedFs.jsonlReads).toEqual([]);
  });

  it("does not mistake a longer underscore-suffixed session id for an exact match", async () => {
    // Intent: exact lookup must decode the complete timestamped filename. A current-dir session
    // ending in `_target` must not hide the actual `target` session in the legacy directory.
    const agentDir = await createTempRoot();
    const cwd = await createTempRoot();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await createPersistedSession(cwd, "prefix_exact-target");
    await createPersistedSession(cwd, "exact-target", legacySessionDir(agentDir, cwd));

    trackedFs.jsonlReads.length = 0;
    expect(getPersistedSubagentView(cwd, "exact-target")).toMatchObject({ sessionId: "exact-target" });
    expectOnlySessionRead("exact-target");
  });
});
