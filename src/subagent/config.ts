import { loadPiBaseSettings, type LoadedPiBaseSettings } from "../config.js";

/** Root=1 can delegate to depth 2; at depth == maxDepth the `task` tool is withheld. */
export const DEFAULT_MAX_DEPTH = 2;
/** Max subagents a single session may run at once; excess `task` calls are rejected. */
export const DEFAULT_MAX_CONCURRENCY = 10;
/** Soft loop cap for delegated subagents; after this many assistant turns pi-base asks the child to finish. */
export const DEFAULT_MAX_TURNS = 50;

export interface ResolvedSubagentConfig {
  maxDepth: number;
  maxConcurrency: number;
  maxTotalConcurrency?: number;
  idleTimeoutMs?: number;
  maxTurns: number;
}

/**
 * Resolve effective subagent limits from merged pi-base settings, applying defaults.
 * Values are already validated as positive integers by the settings sanitizer; the
 * clamping here is a defensive fallback for programmatic/loose inputs.
 */
export function resolveSubagentConfig(loaded: LoadedPiBaseSettings): ResolvedSubagentConfig {
  const config = loaded.settings.subagent;
  const maxTotalConcurrency = normalizeOptionalPositiveInteger(config?.maxTotalConcurrency);
  const idleTimeoutMs = normalizeOptionalTimeout(config?.idleTimeoutMs);
  const maxTurns = normalizePositiveInteger(config?.maxTurns, DEFAULT_MAX_TURNS);
  return {
    maxDepth: normalizePositiveInteger(config?.maxDepth, DEFAULT_MAX_DEPTH),
    maxConcurrency: normalizePositiveInteger(config?.maxConcurrency, DEFAULT_MAX_CONCURRENCY),
    ...(maxTotalConcurrency !== undefined ? { maxTotalConcurrency } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    maxTurns,
  };
}

/** Convenience loader for callers that only have a cwd. */
export function loadSubagentConfig(cwd: string): ResolvedSubagentConfig {
  return resolveSubagentConfig(loadPiBaseSettings(cwd));
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return fallback;
  return value;
}

function normalizeOptionalPositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function normalizeOptionalTimeout(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}
