export interface SubagentPermissionRequest {
  agentType: string;
  depth: number;
  /** Root session id that owns this delegation tree. Used to route asks to the correct UI host. */
  rootSessionId?: string;
  /** Fully-built permission prompt text; the host prepends an agent label and shows Yes/No. */
  prompt: string;
  signal?: AbortSignal;
}

/** Resolves to true = allow, false = deny. */
export type SubagentPermissionHost = (request: SubagentPermissionRequest) => Promise<boolean>;

const DEFAULT_HOST_KEY = "__default__";
const hosts = new Map<string, SubagentPermissionHost>();

function hostKey(rootSessionId: string | undefined): string {
  const normalized = rootSessionId?.trim();
  return normalized ? normalized : DEFAULT_HOST_KEY;
}

/**
 * Register a permission host.
 *
 * Backward-compatible forms:
 * - setSubagentPermissionHost(host)
 * - setSubagentPermissionHost(rootSessionId, host)
 */
export function setSubagentPermissionHost(rootSessionId: string, fn: SubagentPermissionHost): void;
export function setSubagentPermissionHost(fn: SubagentPermissionHost): void;
export function setSubagentPermissionHost(rootSessionIdOrFn: string | SubagentPermissionHost, maybeFn?: SubagentPermissionHost): void {
  if (typeof rootSessionIdOrFn === "function") {
    hosts.set(DEFAULT_HOST_KEY, rootSessionIdOrFn);
    return;
  }
  if (typeof maybeFn !== "function") {
    throw new Error("setSubagentPermissionHost requires a host function.");
  }
  hosts.set(hostKey(rootSessionIdOrFn), maybeFn);
}

/**
 * Clear a permission host.
 *
 * Supported forms:
 * - clearSubagentPermissionHost()                  -> clear all hosts
 * - clearSubagentPermissionHost(host)              -> clear the default host iff it still matches
 * - clearSubagentPermissionHost(rootSessionId)     -> clear that root's host unconditionally
 * - clearSubagentPermissionHost(rootSessionId, fn) -> clear that root's host iff it still matches
 */
export function clearSubagentPermissionHost(): void;
export function clearSubagentPermissionHost(fn: SubagentPermissionHost): void;
export function clearSubagentPermissionHost(rootSessionId: string, fn?: SubagentPermissionHost): void;
export function clearSubagentPermissionHost(rootSessionIdOrFn?: string | SubagentPermissionHost, maybeFn?: SubagentPermissionHost): void {
  if (rootSessionIdOrFn === undefined) {
    hosts.clear();
    return;
  }
  if (typeof rootSessionIdOrFn === "function") {
    if (hosts.get(DEFAULT_HOST_KEY) === rootSessionIdOrFn) hosts.delete(DEFAULT_HOST_KEY);
    return;
  }
  const key = hostKey(rootSessionIdOrFn);
  if (maybeFn === undefined || hosts.get(key) === maybeFn) {
    hosts.delete(key);
  }
}

export function hasSubagentPermissionHost(rootSessionId?: string): boolean {
  if (rootSessionId !== undefined) return hosts.has(hostKey(rootSessionId));
  return hosts.size > 0;
}

/**
 * Ask the registered host for a decision.
 * Returns null when no host is registered for that root session (e.g. non-interactive/print
 * top-level), letting the caller fall back to blocking rather than silently allowing.
 */
export async function askSubagentPermissionHost(request: SubagentPermissionRequest): Promise<boolean | null> {
  const current = hosts.get(hostKey(request.rootSessionId));
  if (!current) return null;
  return current(request);
}
