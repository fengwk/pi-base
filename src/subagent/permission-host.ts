export interface SubagentPermissionRequest {
  agentType: string;
  depth: number;
  /** Fully-built permission prompt text; the host prepends an agent label and shows Allow/Deny. */
  prompt: string;
  signal?: AbortSignal;
}

/** Resolves to true = allow, false = deny. */
export type SubagentPermissionHost = (request: SubagentPermissionRequest) => Promise<boolean>;

let host: SubagentPermissionHost | null = null;

/**
 * The root (UI-owning) session registers a host here so headless subagent sessions can
 * route permission prompts to the main panel. This is a plain module-level function
 * pointer shared across sessions in one process — no cross-process / IPC involved.
 */
export function setSubagentPermissionHost(fn: SubagentPermissionHost): void {
  host = fn;
}

/**
 * Clear the host. Pass the previously-registered function to clear only if it is still
 * the current one, so a stale root shutting down cannot unregister a newer root's host.
 */
export function clearSubagentPermissionHost(fn?: SubagentPermissionHost): void {
  if (fn === undefined || host === fn) host = null;
}

export function hasSubagentPermissionHost(): boolean {
  return host !== null;
}

/**
 * Ask the registered host for a decision.
 * Returns null when no host is registered (e.g. non-interactive/print top-level), letting
 * the caller fall back to blocking rather than silently allowing.
 */
export async function askSubagentPermissionHost(request: SubagentPermissionRequest): Promise<boolean | null> {
  const current = host;
  if (!current) return null;
  return current(request);
}
