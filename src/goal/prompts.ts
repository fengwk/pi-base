import { readFileSync } from "node:fs";
import type { GoalState } from "./state.js";

const GOAL_SET_TEMPLATE = loadGoalPrompt("goal-set.md");
const GOAL_CONTINUATION_TEMPLATE = loadGoalPrompt("goal-continuation.md");
const GOAL_BUDGET_LIMIT_TEMPLATE = loadGoalPrompt("goal-budget-limit.md");
const GOAL_STATUS_AUDIT_TEMPLATE = loadGoalPrompt("goal-status-audit.md");

export function buildGoalContinuationPrompt(state: GoalState): string {
  return `${renderGoalPrompt(GOAL_CONTINUATION_TEMPLATE, {
    objective: escapeXmlText(state.objective),
    tokensUsed: String(state.tokensUsed),
    tokenBudget: state.tokenBudget === null ? "none" : String(state.tokenBudget),
    remainingTokens: state.tokenBudget === null ? "unbounded" : String(Math.max(0, state.tokenBudget - state.tokensUsed)),
  })}\n\n${GOAL_STATUS_AUDIT_TEMPLATE}`;
}

export function buildGoalSetPrompt(state: GoalState): string {
  return `${renderGoalPrompt(GOAL_SET_TEMPLATE, { objective: escapeXmlText(state.objective) })}\n\n${GOAL_STATUS_AUDIT_TEMPLATE}`;
}

export function buildGoalBudgetLimitPrompt(state: GoalState): string {
  return renderGoalPrompt(GOAL_BUDGET_LIMIT_TEMPLATE, {
    objective: escapeXmlText(state.objective),
    timeUsedSeconds: String(state.timeUsedSeconds),
    tokensUsed: String(state.tokensUsed),
    tokenBudget: state.tokenBudget === null ? "none" : String(state.tokenBudget),
  });
}

function loadGoalPrompt(name: string): string {
  return readFileSync(new URL(`../../prompts/${name}`, import.meta.url), "utf8").trim();
}

function renderGoalPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (placeholder, name: string) => values[name] ?? placeholder);
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
