import { createHash } from "node:crypto";

interface NoopLoopEntry {
  hash: string;
  count: number;
}

export interface NoopLoopGuard {
  entries: Map<string, NoopLoopEntry>;
}

/** After this many consecutive identical no-op edits on the same path, escalate. */
export const NOOP_HARD_LIMIT = 3;

export function createNoopLoopGuard(): NoopLoopGuard {
  return { entries: new Map() };
}

export interface NoopRecordResult {
  count: number;
  escalate: boolean;
}

export function recordNoopEdit(guard: NoopLoopGuard, canonicalPath: string, inputHash: string): NoopRecordResult {
  const previous = guard.entries.get(canonicalPath);
  const count = previous && previous.hash === inputHash ? previous.count + 1 : 1;
  guard.entries.set(canonicalPath, { hash: inputHash, count });
  return { count, escalate: count >= NOOP_HARD_LIMIT };
}

export function resetNoopEdit(guard: NoopLoopGuard, canonicalPath: string): void {
  guard.entries.delete(canonicalPath);
}

export function hashPatchInput(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
