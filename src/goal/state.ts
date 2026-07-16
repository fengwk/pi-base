import type { Usage } from "@earendil-works/pi-ai";

export const GOAL_STATE_ENTRY_TYPE = "pi-base-goal-state";

export type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete";

export interface GoalState {
  version: 1;
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalSnapshot {
  goal: GoalState | null;
  statusBarEnabled: boolean;
}

export function createGoalState(
  objective: string,
  tokenBudget: number | null,
  now = Date.now(),
  random = Math.random(),
): GoalState {
  return {
    version: 1,
    id: `${now}-${random.toString(16).slice(2)}`,
    objective,
    status: "active",
    tokenBudget,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function accountGoalTurn(
  state: GoalState,
  tokenDelta: number,
  elapsedSeconds: number,
  now = Date.now(),
): GoalState {
  const next: GoalState = {
    ...state,
    tokensUsed: state.tokensUsed + Math.max(0, tokenDelta),
    timeUsedSeconds: state.timeUsedSeconds + Math.max(0, elapsedSeconds),
    updatedAt: now,
  };
  if (next.status !== "active" || next.tokenBudget === null || next.tokensUsed < next.tokenBudget) {
    return next;
  }
  return { ...next, status: "budget_limited" };
}

/** Codex-compatible budget accounting: new/non-cached input plus output. */
export function tokenDeltaFromUsage(usage: Partial<Usage> | null | undefined): number {
  if (!usage) return 0;
  const hasComponents = [usage.input, usage.output, usage.cacheWrite].some((value) => typeof value === "number");
  if (!hasComponents) {
    return typeof usage.totalTokens === "number" ? Math.max(0, usage.totalTokens) : 0;
  }
  return Math.max(0, finiteNumber(usage.input) + finiteNumber(usage.output) + finiteNumber(usage.cacheWrite));
}

export function parseTokenBudget(input: string): { objective: string; tokenBudget: number | null; error?: string } {
  const match = input.match(/(?:^|\s)--tokens(?:=|\s+)(\S+\s*[kKmM]?)(?:\s|$)/);
  if (!match) return { objective: input.trim(), tokenBudget: null };

  const raw = match[1].replace(/\s+/g, "");
  const suffix = raw.slice(-1).toLowerCase();
  const numeric = suffix === "k" || suffix === "m" ? raw.slice(0, -1) : raw;
  const value = Number(numeric);
  if (!Number.isFinite(value) || value <= 0) {
    return { objective: input.trim(), tokenBudget: null, error: "Token budget must be positive." };
  }
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const tokenBudget = Math.round(value * multiplier);
  const objective = `${input.slice(0, match.index)} ${input.slice((match.index ?? 0) + match[0].length)}`.trim();
  return { objective, tokenBudget };
}

export function normalizeTokenBudget(value: unknown): { tokenBudget: number | null; error?: string } {
  if (value === undefined || value === null) return { tokenBudget: null };
  const tokenBudget = Math.round(Number(value));
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    return { tokenBudget: null, error: "tokenBudget must be a positive number when provided." };
  }
  return { tokenBudget };
}

export function restoreGoalSnapshot(entries: readonly unknown[]): GoalSnapshot {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom") continue;
    if (entry.customType !== GOAL_STATE_ENTRY_TYPE) continue;
    const snapshot = parseGoalSnapshot(entry.data);
    if (snapshot) return snapshot;
  }
  return { goal: null, statusBarEnabled: true };
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function formatGoalUsage(state: GoalState): string {
  if (state.tokenBudget !== null) {
    return `${formatTokens(state.tokensUsed)} / ${formatTokens(state.tokenBudget)} tokens`;
  }
  return formatElapsed(state.timeUsedSeconds);
}

export function formatGoalStatus(state: GoalState | null): string | undefined {
  if (!state) return undefined;
  const usage = state.tokenBudget === null
    ? ` (${formatElapsed(state.timeUsedSeconds)})`
    : ` (${formatTokens(state.tokensUsed)} / ${formatTokens(state.tokenBudget)})`;
  switch (state.status) {
    case "active":
      return `goal:active${usage}`;
    case "paused":
      return "goal:paused";
    case "blocked":
      return "goal:blocked";
    case "budget_limited":
      return `goal:budget${usage}`;
    case "complete":
      return `goal:complete${usage}`;
  }
}

export function truncateObjective(objective: string, maxLength = 96): string {
  const singleLine = objective.replace(/\s+/g, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

function parseGoalSnapshot(value: unknown): GoalSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const statusBarEnabled = typeof value.statusBarEnabled === "boolean" ? value.statusBarEnabled : true;
  if (value.goal === null) return { goal: null, statusBarEnabled };
  const goal = parseGoalState(value.goal);
  return goal ? { goal, statusBarEnabled } : undefined;
}

function parseGoalState(value: unknown): GoalState | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1 || typeof value.id !== "string" || typeof value.objective !== "string") return undefined;
  if (!isGoalStatus(value.status)) return undefined;
  const tokenBudget = value.tokenBudget;
  if (tokenBudget !== null && (!Number.isFinite(tokenBudget) || Number(tokenBudget) <= 0)) return undefined;
  const tokensUsed = parseNonNegativeNumber(value.tokensUsed);
  const timeUsedSeconds = parseNonNegativeNumber(value.timeUsedSeconds);
  const createdAt = parseNonNegativeNumber(value.createdAt);
  const updatedAt = parseNonNegativeNumber(value.updatedAt);
  if (tokensUsed === undefined || timeUsedSeconds === undefined || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  return {
    version: 1,
    id: value.id,
    objective: value.objective,
    status: value.status,
    tokenBudget: tokenBudget === null ? null : Number(tokenBudget),
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  };
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active"
    || value === "paused"
    || value === "blocked"
    || value === "budget_limited"
    || value === "complete";
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
