import { loadPiBaseSettings, type LoadedPiBaseSettings } from "../config.js";

/** Root=1 can delegate to depth 2; at depth == maxDepth the `task` tool is withheld. */
export const DEFAULT_MAX_DEPTH = 2;
/** Max subagents a single session may run at once; excess `task` calls are rejected. */
export const DEFAULT_MAX_CONCURRENCY = 10;

export interface ResolvedSubagentConfig {
  maxDepth: number;
  maxConcurrency: number;
}

/**
 * Resolve effective subagent limits from merged pi-base settings, applying defaults.
 * Values are already validated as positive integers by the settings sanitizer; the
 * clamping here is a defensive fallback for programmatic/loose inputs.
 */
export function resolveSubagentConfig(loaded: LoadedPiBaseSettings): ResolvedSubagentConfig {
  const config = loaded.settings.subagent;
  return {
    maxDepth: normalizePositiveInteger(config?.maxDepth, DEFAULT_MAX_DEPTH),
    maxConcurrency: normalizePositiveInteger(config?.maxConcurrency, DEFAULT_MAX_CONCURRENCY),
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
