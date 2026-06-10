import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent, SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";

export interface SubagentConfig {
  name: string;
  description: string;
  tools: string[];
  skills: string[];
  model?: string;
  thinking?: ThinkingLevel;
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

export interface SubagentRunDetails {
  sessionId?: string;
  sessionFile?: string;
  mode: "new" | "resume";
  name: string;
  status: "running" | "completed" | "failed";
  tailLines: string[];
  summary: string;
  transcriptLines?: string[];
  error?: string;
}

export interface SubagentActivityEntry extends SubagentRunDetails {
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
