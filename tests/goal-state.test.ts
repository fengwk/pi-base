import { describe, expect, it } from "vitest";
import {
  accountGoalTurn,
  createGoalState,
  formatElapsed,
  formatGoalStatus,
  formatGoalUsage,
  formatTokens,
  GOAL_STATE_ENTRY_TYPE,
  normalizeTokenBudget,
  parseTokenBudget,
  restoreGoalSnapshot,
  truncateObjective,
  type GoalState,
} from "../src/goal/state.js";

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return { ...createGoalState("ship the feature", null, 1_000, 0.5), ...overrides };
}

function snapshotEntry(data: unknown) {
  return { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data };
}

describe("goal token budget parsing", () => {
  it("returns the trimmed objective and no budget when --tokens is absent", () => {
    expect(parseTokenBudget("  finish the migration  ")).toEqual({
      objective: "finish the migration",
      tokenBudget: null,
    });
  });

  it("applies k/m suffixes case-insensitively and strips the flag from the objective", () => {
    // Intent: the budget drives real spend accounting, so each suffix must map to an exact
    // multiplier and must never leak back into the persisted objective text.
    expect(parseTokenBudget("--tokens 50k refactor auth")).toEqual({ objective: "refactor auth", tokenBudget: 50_000 });
    expect(parseTokenBudget("refactor auth --tokens=2M")).toEqual({ objective: "refactor auth", tokenBudget: 2_000_000 });
    expect(parseTokenBudget("audit --tokens 1500 the parser")).toEqual({ objective: "audit the parser", tokenBudget: 1_500 });
  });

  it("rounds fractional budgets to whole tokens", () => {
    expect(parseTokenBudget("--tokens 1.5k plan").tokenBudget).toBe(1_500);
    expect(parseTokenBudget("--tokens 2.5 plan").tokenBudget).toBe(3);
  });

  it("rejects non-positive and non-numeric budgets while keeping the raw objective", () => {
    expect(parseTokenBudget("--tokens 0 plan")).toEqual({
      objective: "--tokens 0 plan",
      tokenBudget: null,
      error: "Token budget must be positive.",
    });
    expect(parseTokenBudget("--tokens -5 plan").error).toBe("Token budget must be positive.");
    expect(parseTokenBudget("--tokens abc plan").error).toBe("Token budget must be positive.");
  });

  it("normalizes tool-supplied budgets and rejects invalid ones", () => {
    expect(normalizeTokenBudget(undefined)).toEqual({ tokenBudget: null });
    expect(normalizeTokenBudget(null)).toEqual({ tokenBudget: null });
    expect(normalizeTokenBudget(1_234.6)).toEqual({ tokenBudget: 1_235 });
    expect(normalizeTokenBudget(0).error).toBe("tokenBudget must be a positive number when provided.");
    expect(normalizeTokenBudget(-1).error).toBe("tokenBudget must be a positive number when provided.");
    expect(normalizeTokenBudget(Number.NaN).error).toBe("tokenBudget must be a positive number when provided.");
    expect(normalizeTokenBudget("nope").error).toBe("tokenBudget must be a positive number when provided.");
  });
});

describe("goal turn accounting", () => {
  it("accumulates usage and ignores negative deltas", () => {
    const next = accountGoalTurn(goal({ tokensUsed: 10, timeUsedSeconds: 5 }), -100, -3, 2_000);
    expect(next).toMatchObject({ tokensUsed: 10, timeUsedSeconds: 5, status: "active", updatedAt: 2_000 });
  });

  it("switches an active goal to budget_limited once the budget is reached", () => {
    const next = accountGoalTurn(goal({ tokenBudget: 100, tokensUsed: 90 }), 10, 1, 2_000);
    expect(next.status).toBe("budget_limited");
  });

  it("leaves a non-active goal's status untouched even past its budget", () => {
    // Intent: only the active-run path may declare budget exhaustion; paused/blocked goals keep
    // the status the user or model last set.
    const next = accountGoalTurn(goal({ status: "paused", tokenBudget: 100, tokensUsed: 90 }), 50, 1, 2_000);
    expect(next).toMatchObject({ status: "paused", tokensUsed: 140 });
  });
});

describe("goal formatting", () => {
  it("abbreviates token counts at the K and M thresholds", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokens(1_550)).toBe("1.6K");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(2_450_000)).toBe("2.5M");
  });

  it("abbreviates elapsed time at the minute and hour thresholds", () => {
    expect(formatElapsed(59)).toBe("59s");
    expect(formatElapsed(60)).toBe("1m");
    expect(formatElapsed(3_600)).toBe("1h");
    expect(formatElapsed(3_900)).toBe("1h 5m");
  });

  it("reports usage as tokens when budgeted and as elapsed time otherwise", () => {
    expect(formatGoalUsage(goal({ tokenBudget: 50_000, tokensUsed: 12_300 }))).toBe("12.3K / 50K tokens");
    expect(formatGoalUsage(goal({ tokenBudget: null, timeUsedSeconds: 90 }))).toBe("1m");
  });

  it("renders a status label per goal status", () => {
    expect(formatGoalStatus(null)).toBeUndefined();
    expect(formatGoalStatus(goal({ tokenBudget: 1_000, tokensUsed: 250 }))).toBe("goal:active (250 / 1K)");
    expect(formatGoalStatus(goal({ timeUsedSeconds: 30 }))).toBe("goal:active (30s)");
    expect(formatGoalStatus(goal({ status: "paused" }))).toBe("goal:paused");
    expect(formatGoalStatus(goal({ status: "blocked" }))).toBe("goal:blocked");
    expect(formatGoalStatus(goal({ status: "budget_limited", tokenBudget: 100, tokensUsed: 100 }))).toBe("goal:budget (100 / 100)");
    expect(formatGoalStatus(goal({ status: "complete", timeUsedSeconds: 5 }))).toBe("goal:complete (5s)");
  });

  it("collapses whitespace and truncates long objectives", () => {
    expect(truncateObjective("  keep\n  it   short  ")).toBe("keep it short");
    expect(truncateObjective("x".repeat(200))).toBe(`${"x".repeat(95)}…`);
    expect(truncateObjective("x".repeat(10), 10)).toBe("x".repeat(10));
  });
});

describe("goal snapshot restoration", () => {
  it("returns the default snapshot when no goal entry exists", () => {
    expect(restoreGoalSnapshot([])).toEqual({ goal: null, statusBarEnabled: true });
    expect(restoreGoalSnapshot([{ type: "message" }, snapshotEntry(undefined)])).toEqual({
      goal: null,
      statusBarEnabled: true,
    });
  });

  it("ignores custom entries owned by other extensions", () => {
    const entries = [{ type: "custom", customType: "other-extension", data: { goal: goal() } }];
    expect(restoreGoalSnapshot(entries)).toEqual({ goal: null, statusBarEnabled: true });
  });

  it("restores the most recent valid snapshot", () => {
    const older = goal({ objective: "older" });
    const newer = goal({ objective: "newer" });
    const restored = restoreGoalSnapshot([snapshotEntry({ goal: older }), snapshotEntry({ goal: newer, statusBarEnabled: false })]);
    expect(restored).toEqual({ goal: newer, statusBarEnabled: false });
  });

  it("skips malformed snapshots and falls back to an older valid one", () => {
    // Intent: a corrupted or partially-written entry must not resurrect a bogus goal; recovery
    // walks backwards to the newest entry that still parses.
    const valid = goal({ objective: "valid" });
    const restored = restoreGoalSnapshot([
      snapshotEntry({ goal: valid }),
      snapshotEntry({ goal: { ...valid, version: 2 } }),
    ]);
    expect(restored.goal).toEqual(valid);
  });

  it("preserves an explicitly cleared goal", () => {
    expect(restoreGoalSnapshot([snapshotEntry({ goal: goal() }), snapshotEntry({ goal: null })])).toEqual({
      goal: null,
      statusBarEnabled: true,
    });
  });

  it("rejects goal states with invalid fields", () => {
    const base = goal({ tokenBudget: 100 });
    const invalidStates: unknown[] = [
      "not-an-object",
      { ...base, id: 1 },
      { ...base, objective: null },
      { ...base, status: "unknown" },
      { ...base, tokenBudget: 0 },
      { ...base, tokenBudget: Number.NaN },
      { ...base, tokensUsed: -1 },
      { ...base, timeUsedSeconds: "5" },
      { ...base, createdAt: Number.POSITIVE_INFINITY },
      { ...base, updatedAt: undefined },
    ];
    for (const invalid of invalidStates) {
      expect(restoreGoalSnapshot([snapshotEntry({ goal: invalid })]).goal).toBeNull();
    }
  });

  it("defaults statusBarEnabled to true when the persisted flag is not a boolean", () => {
    const restored = restoreGoalSnapshot([snapshotEntry({ goal: goal(), statusBarEnabled: "yes" })]);
    expect(restored.statusBarEnabled).toBe(true);
  });
});
