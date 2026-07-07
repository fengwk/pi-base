import { EventEmitter } from "node:events";

export type SubagentStatus = "running" | "done" | "error" | "cancelled" | "interrupted";

export interface SubagentNode {
  /** Child session id — also the value returned to the delegating agent for resume. */
  sessionId: string;
  /** Delegating (parent) session id; used to reconstruct the tree. */
  parentSessionId: string;
  agentType: string;
  description: string;
  depth: number;
  status: SubagentStatus;
  toolCount: number;
  startedAt: number;
  endedAt?: number;
}

const CHANGE_EVENT = "change";

/**
 * Process-wide, in-memory view of every subagent across the whole delegation tree.
 * Shared across sessions via the pi-base module singleton (same Node module instance);
 * it is the authoritative source for "what is running now". Never persisted — a crash
 * clears it, which is exactly what prevents zombie tree state on resume.
 */
export class SubagentRegistry extends EventEmitter {
  private readonly nodes = new Map<string, SubagentNode>();

  constructor() {
    super();
    // Deliberate process-global bus: one `change` listener is added per UI-owning root session
    // (added on session_start, removed on session_shutdown). Production has ~1 root at a time, but
    // multi-session hosts and the test suite create many short-lived subscribers, so the arbitrary
    // 10-listener cap would false-positive. Disable it; lifecycle-based unsubscribe prevents real leaks.
    this.setMaxListeners(0);
  }

  upsert(node: SubagentNode): void {
    this.nodes.set(node.sessionId, { ...node });
    this.emit(CHANGE_EVENT);
  }

  update(sessionId: string, patch: Partial<Omit<SubagentNode, "sessionId">>): void {
    const existing = this.nodes.get(sessionId);
    if (!existing) return;
    this.nodes.set(sessionId, { ...existing, ...patch });
    this.emit(CHANGE_EVENT);
  }

  get(sessionId: string): SubagentNode | undefined {
    const node = this.nodes.get(sessionId);
    return node ? { ...node } : undefined;
  }

  children(parentSessionId: string): SubagentNode[] {
    return [...this.nodes.values()]
      .filter((node) => node.parentSessionId === parentSessionId)
      .map((node) => ({ ...node }));
  }

  /** Count of a session's currently-running direct children (for concurrency enforcement). */
  runningChildCount(parentSessionId: string): number {
    let count = 0;
    for (const node of this.nodes.values()) {
      if (node.parentSessionId === parentSessionId && node.status === "running") count += 1;
    }
    return count;
  }

  all(): SubagentNode[] {
    return [...this.nodes.values()].map((node) => ({ ...node }));
  }

  remove(sessionId: string): void {
    if (this.nodes.delete(sessionId)) this.emit(CHANGE_EVENT);
  }

  clear(): void {
    if (this.nodes.size === 0) return;
    this.nodes.clear();
    this.emit(CHANGE_EVENT);
  }

  /** Subscribe to any change; returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.on(CHANGE_EVENT, listener);
    return () => {
      this.off(CHANGE_EVENT, listener);
    };
  }
}

/** The shared singleton. All sessions in one pi process read/write this instance. */
export const subagentRegistry = new SubagentRegistry();
