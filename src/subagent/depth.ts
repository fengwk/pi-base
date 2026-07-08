import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Custom session entry carrying a subagent session's delegation depth (ignored by the LLM context). */
export const DEPTH_ENTRY = "pi-base-subagent-depth";
/** Custom session entry carrying the root session id that owns this delegation tree. */
export const ROOT_SESSION_ENTRY = "pi-base-subagent-root-session";
/** Sessions without a depth entry (the user's main session) are the delegation root. */
export const ROOT_DEPTH = 1;

interface DepthEntry {
  type: string;
  customType?: string;
  data?: { depth?: unknown };
}

interface RootSessionEntry {
  type: string;
  customType?: string;
  data?: { rootSessionId?: unknown };
}

type DepthContext = Pick<ExtensionContext, "sessionManager">;
type RootSessionContext = Pick<ExtensionContext, "sessionManager">;

/**
 * Read a session's delegation depth from its persisted depth entry.
 * Missing/invalid → ROOT_DEPTH, so a plain user session is depth 1 and resumed
 * subagent sessions recover their depth from disk.
 */
export function readDepth(ctx: DepthContext): number {
  const entries = ctx.sessionManager.getEntries() as DepthEntry[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === DEPTH_ENTRY) {
      const depth = entry.data?.depth;
      if (typeof depth === "number" && Number.isInteger(depth) && depth >= ROOT_DEPTH) {
        return depth;
      }
    }
  }
  return ROOT_DEPTH;
}

/**
 * Read the root session id for this delegation tree.
 * Root sessions fall back to their own session id; child sessions restore the
 * persisted root id written when they were spawned.
 */
export function readRootSessionId(ctx: RootSessionContext): string {
  const entries = ctx.sessionManager.getEntries() as RootSessionEntry[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === ROOT_SESSION_ENTRY) {
      const rootSessionId = entry.data?.rootSessionId;
      if (typeof rootSessionId === "string" && rootSessionId.trim().length > 0) {
        return rootSessionId.trim();
      }
    }
  }
  const currentSessionId = ctx.sessionManager.getSessionId?.();
  return typeof currentSessionId === "string" ? currentSessionId : "";
}

/** True when this session owns the real UI (only the root session paints main-panel chrome). */
export function isRootSession(ctx: DepthContext): boolean {
  return readDepth(ctx) === ROOT_DEPTH;
}

/** Build the depth entry payload for a child session created at `childDepth`. */
export function depthEntryData(childDepth: number): { depth: number } {
  return { depth: childDepth };
}

/** Build the root-session entry payload for a child session created under `rootSessionId`. */
export function rootSessionEntryData(rootSessionId: string): { rootSessionId: string } {
  return { rootSessionId };
}
