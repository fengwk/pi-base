import type { SubagentActivityEntry, SubagentToolDetails } from "./types.js";

class SubagentActivityStore {
  private readonly entries = new Map<string, SubagentActivityEntry>();

  upsert(details: Omit<SubagentActivityEntry, "updatedAt">): void {
    this.entries.set(details.sessionId ?? `${details.name}:${details.mode}`, {
      ...details,
      updatedAt: Date.now(),
    });
  }

  finish(details: SubagentToolDetails & { parentSessionPath?: string }): void {
    const key = details.sessionId ?? `${details.name}:${details.mode}`;
    const current = this.entries.get(key);
    this.entries.set(key, {
      sessionId: details.sessionId,
      sessionFile: details.sessionFile,
      mode: details.mode,
      name: details.name,
      status: details.status,
      tailLines: [...details.tailLines],
      summary: details.summary,
      error: details.error,
      parentSessionPath: details.parentSessionPath ?? current?.parentSessionPath,
      currentResponseText: "",
      activeTools: [],
      updatedAt: Date.now(),
    });
  }

  get(sessionId: string): SubagentActivityEntry | undefined {
    return this.entries.get(sessionId);
  }

  list(): SubagentActivityEntry[] {
    return Array.from(this.entries.values()).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  clear(): void {
    this.entries.clear();
  }
}

export const subagentActivityStore = new SubagentActivityStore();

export type { SubagentActivityStore };
