import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir, type SessionEntry, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { SubagentInvocationEntry } from "./types.js";

export const SUBAGENT_INVOCATION_ENTRY_TYPE = "pi-base-subagent-invocation";

function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
function isEncodedCwdDir(name: string): boolean {
  return name.startsWith("--") && name.endsWith("--");
}

export function deriveSubagentSessionDir(cwd: string, parentSessionDir?: string, agentDir: string = getAgentDir()): string {
  if (!parentSessionDir) {
    return join(getSubagentSessionsRoot(agentDir), encodeCwd(cwd));
  }

  const currentDirName = basename(parentSessionDir);
  if (isEncodedCwdDir(currentDirName)) {
    const parentRoot = dirname(parentSessionDir);
    const siblingRoot = join(dirname(parentRoot), `${basename(parentRoot)}-subagents`);
    mkdirSync(siblingRoot, { recursive: true });
    const derived = join(siblingRoot, currentDirName);
    mkdirSync(derived, { recursive: true });
    return derived;
  }

  const derived = `${parentSessionDir}-subagents`;
  mkdirSync(derived, { recursive: true });
  return derived;
}

export function getSubagentSessionsRoot(agentDir: string = getAgentDir()): string {
  const root = join(agentDir, "sessions-subagents");
  mkdirSync(root, { recursive: true });
  return root;
}

export function getSubagentSessionDir(cwd: string, agentDir: string = getAgentDir(), parentSessionDir?: string): string {
  return deriveSubagentSessionDir(cwd, parentSessionDir, agentDir);
}

export function createSubagentSessionManager(
  cwd: string,
  parentSessionPath?: string,
  agentDir: string = getAgentDir(),
  parentSessionDir?: string,
): SessionManager {
  const sessionDir = getSubagentSessionDir(cwd, agentDir, parentSessionDir);
  const manager = SessionManager.create(cwd, sessionDir);
  if (parentSessionPath) {
    const header = manager.getHeader();
    if (header) header.parentSession = parentSessionPath;
  }
  return manager;
}

export async function listSubagentSessions(cwd: string, agentDir: string = getAgentDir(), parentSessionDir?: string): Promise<SessionInfo[]> {
  return SessionManager.list(cwd, getSubagentSessionDir(cwd, agentDir, parentSessionDir));
}

export async function findSubagentSessionInfo(
  cwd: string,
  sessionId: string,
  agentDir: string = getAgentDir(),
  parentSessionDir?: string,
): Promise<SessionInfo | undefined> {
  const sessions = await listSubagentSessions(cwd, agentDir, parentSessionDir);
  return sessions.find((info) => info.id === sessionId);
}

export async function openSubagentSessionManager(
  cwd: string,
  sessionId: string,
  agentDir: string = getAgentDir(),
  parentSessionDir?: string,
): Promise<SessionManager> {
  const info = await findSubagentSessionInfo(cwd, sessionId, agentDir, parentSessionDir);
  if (!info) {
    throw new Error(`Unknown subagent session_id: ${sessionId}`);
  }
  return SessionManager.open(info.path, getSubagentSessionDir(cwd, agentDir, parentSessionDir));
}

export function appendSubagentInvocation(
  manager: SessionManager,
  entry: SubagentInvocationEntry,
): void {
  manager.appendCustomEntry(SUBAGENT_INVOCATION_ENTRY_TYPE, entry);
}

export function readSubagentInvocations(entries: SessionEntry[]): SubagentInvocationEntry[] {
  const invocations: SubagentInvocationEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SUBAGENT_INVOCATION_ENTRY_TYPE) continue;
    const data = entry.data && typeof entry.data === "object" ? entry.data as Record<string, unknown> : {};
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name) continue;
    invocations.push({
      name,
      timestamp: typeof data.timestamp === "string" ? data.timestamp : "",
      parentSessionId: (data.parentSessionId as string | null | undefined) ?? undefined,
      callerSessionId: (data.callerSessionId as string | null | undefined) ?? undefined,
    });
  }
  return invocations;
}

export function getLatestSubagentInvocation(entries: SessionEntry[]): SubagentInvocationEntry | undefined {
  const invocations = readSubagentInvocations(entries);
  return invocations[invocations.length - 1];
}

export function collapseInvocationChain(entries: SessionEntry[]): string[] {
  const chain = readSubagentInvocations(entries).map((entry) => entry.name.trim()).filter(Boolean);
  const collapsed: string[] = [];
  for (const name of chain) {
    if (collapsed[collapsed.length - 1] !== name) collapsed.push(name);
  }
  return collapsed;
}
