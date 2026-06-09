import type { SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface SubagentConfig {
  name: string;
  description: string;
  tools: string[];
  skills: string[];
  subagents: string[];
  body: string;
  filePath: string;
  source: "project" | "global";
}

export interface SubagentInvocationEntry {
  name: string;
  timestamp: string;
  parentSessionId?: string | null;
  callerSessionId?: string | null;
}

export interface SubagentToolDetails {
  sessionId?: string;
  sessionFile?: string;
  mode: "new" | "resume";
  name: string;
  status: "running" | "completed" | "failed";
  tailLines: string[];
  summary: string;
  error?: string;
}

export interface SubagentActivityEntry extends SubagentToolDetails {
  updatedAt: number;
  parentSessionPath?: string;
  currentResponseText: string;
  activeTools: string[];
  session?: AgentSessionLike;
}

export interface SubagentSessionRecord {
  info: SessionInfo;
  currentName: string;
  invocationChain: string[];
  status: "running" | "completed" | "failed";
  summary: string;
  tailLines: string[];
}

export interface SubagentTreeNode {
  record: SubagentSessionRecord;
  children: SubagentTreeNode[];
}

export interface AgentSessionLike {
  sessionId: string;
  sessionFile?: string;
  messages: unknown[];
  sessionManager: SessionManager;
  bindExtensions(bindings: { onError?: (error: Error & { extensionPath?: string }) => void }): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  setSessionName(name: string): void;
  abort(): Promise<void>;
  dispose(): void;
}
