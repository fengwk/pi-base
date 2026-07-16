import { Type } from "@sinclair/typebox";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { loadToolDescription } from "../tool-prompt.js";
import { buildGoalBudgetLimitPrompt, buildGoalContinuationPrompt, buildGoalSetPrompt } from "./prompts.js";
import {
  accountGoalTurn,
  createGoalState,
  formatGoalStatus,
  formatGoalUsage,
  GOAL_STATE_ENTRY_TYPE,
  normalizeTokenBudget,
  parseTokenBudget,
  restoreGoalSnapshot,
  tokenDeltaFromUsage,
  truncateObjective,
  type GoalSnapshot,
  type GoalState,
} from "./state.js";

export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const GET_GOAL_TOOL_NAME = "get_goal";
export const UPDATE_GOAL_TOOL_NAME = "update_goal";
export const GOAL_TOOL_NAMES = [CREATE_GOAL_TOOL_NAME, GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME] as const;

const GOAL_CONTROL_MESSAGE_TYPE = "pi-base-goal-control";
const GOAL_STATUS_KEY = "03-pi-base-goal";
const BUDGET_REMINDER_INTERVAL = 5;

type GoalControlKind = "goal_set" | "continuation" | "budget_limit";

interface GoalControlDetails {
  kind: GoalControlKind;
  goal: GoalState;
}

export interface GoalSupportHandle {
  getGoal: () => GoalState | null;
  getInjectedToolNames: (hasExplicitToolPolicy: boolean) => string[];
}

export interface GoalSupportOptions {
  /** Restricts durable goal mode to sessions owned by the primary agent. */
  isSessionSupported?: (ctx: ExtensionContext) => boolean;
}

interface ContextMessageShape {
  role: string;
  customType?: string;
  details?: unknown;
  stopReason?: string;
}

export function registerGoalSupport(pi: ExtensionAPI, options: GoalSupportOptions = {}): GoalSupportHandle {
  let goal: GoalState | null = null;
  let statusBarEnabled = true;
  let sessionSupported = true;
  let runGoalId: string | null = null;
  // Survives agent_end so the settled stop reason cannot affect a goal replaced mid-run.
  let settledRunGoalId: string | null = null;
  let currentTurnStartedAt: number | null = null;
  let lastStopReason: AssistantMessage["stopReason"] | undefined;
  let budgetWrapupGoalId: string | null = null;
  let budgetToolTurnsSinceReminder = 0;
  let continuationTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  const clearContinuationTimer = (): void => {
    if (!continuationTimer) return;
    clearTimeout(continuationTimer);
    continuationTimer = null;
  };

  const clearBudgetWrapup = (): void => {
    budgetWrapupGoalId = null;
    budgetToolTurnsSinceReminder = 0;
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(GOAL_STATUS_KEY, statusBarEnabled ? formatGoalStatus(goal) ?? "" : "");
  };

  const isBudgetWrapup = (): boolean =>
    goal !== null && goal.status === "budget_limited" && budgetWrapupGoalId === goal.id;

  const goalRuntimeToolsEnabled = (): boolean =>
    sessionSupported && goal !== null && (goal.status === "active" || isBudgetWrapup());

  const syncGoalTools = (): void => {
    const current = pi.getActiveTools();
    const hadCreateGoal = current.includes(CREATE_GOAL_TOOL_NAME);
    const next = current.filter((name) => !GOAL_TOOL_NAMES.includes(name as (typeof GOAL_TOOL_NAMES)[number]));
    if (sessionSupported && hadCreateGoal) next.push(CREATE_GOAL_TOOL_NAME);
    if (goalRuntimeToolsEnabled()) {
      next.push(GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME);
    }
    if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
      pi.setActiveTools(next);
    }
  };

  const persistSnapshot = (ctx: ExtensionContext): void => {
    const snapshot: GoalSnapshot = { goal, statusBarEnabled };
    pi.appendEntry(GOAL_STATE_ENTRY_TYPE, snapshot);
    updateStatus(ctx);
    syncGoalTools();
  };

  const setGoal = (ctx: ExtensionContext, next: GoalState | null): void => {
    generation++;
    clearContinuationTimer();
    goal = next;
    persistSnapshot(ctx);
  };

  const emitControlMessage = (
    kind: GoalControlKind,
    state: GoalState,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" },
  ): void => {
    pi.sendMessage<GoalControlDetails>(
      {
        customType: GOAL_CONTROL_MESSAGE_TYPE,
        // sendMessage({ triggerTurn: true }) starts Agent.run directly and deliberately bypasses
        // before_agent_start, so this message must carry the full continuation contract itself.
        content: buildGoalControlPrompt(kind, state),
        display: true,
        details: { kind, goal: state },
      },
      options,
    );
  };

  const startContinuation = (ctx: ExtensionContext): void => {
    clearContinuationTimer();
    if (!goal || goal.status !== "active" || !ctx.isIdle()) return;
    emitControlMessage("continuation", goal, { triggerTurn: true });
  };

  const scheduleContinuation = (ctx: ExtensionContext): void => {
    clearContinuationTimer();
    if (!goal || goal.status !== "active") return;
    const scheduledGeneration = generation;
    continuationTimer = setTimeout(() => {
      continuationTimer = null;
      if (scheduledGeneration !== generation) return;
      startContinuation(ctx);
    }, 0);
  };

  const notify = (ctx: ExtensionContext, message: string, variant: "info" | "warning" | "error" = "info"): void => {
    if (ctx.hasUI) ctx.ui.notify(message, variant);
  };

  const isGoalSessionSupported = (ctx: ExtensionContext): boolean =>
    options.isSessionSupported?.(ctx) ?? true;

  const announceUserGoalSet = (state: GoalState): void => {
    emitControlMessage("goal_set", state, { triggerTurn: true, deliverAs: "steer" });
  };

  const replaceGoal = (
    ctx: ExtensionContext,
    objective: string,
    tokenBudget: number | null,
    source: "user" | "model",
  ): GoalState => {
    const next = createGoalState(objective, tokenBudget);
    clearBudgetWrapup();
    setGoal(ctx, next);
    if (source === "user") announceUserGoalSet(next);
    else if (ctx.isIdle()) startContinuation(ctx);
    return next;
  };

  pi.registerMessageRenderer<GoalControlDetails>(GOAL_CONTROL_MESSAGE_TYPE, (message, options, theme) => {
    const details = isGoalControlDetails(message.details) ? message.details : undefined;
    const state = details?.goal;
    const kind = details?.kind ?? "continuation";
    const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
    const label = kind === "budget_limit" ? "Goal budget" : kind === "goal_set" ? "Goal set" : "Goal continuation";
    box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(label)), 0, 0));
    box.addChild(new Spacer(1));
    if (!state) {
      box.addChild(new Text(String(message.content ?? ""), 0, 0));
      return box;
    }
    const summary = [
      `${theme.fg("dim", "Objective: ")}${theme.fg("customMessageText", truncateObjective(state.objective))}`,
      `${theme.fg("dim", "Usage: ")}${theme.fg("customMessageText", formatGoalUsage(state))}`,
      kind === "goal_set"
        ? theme.fg("dim", "User-set goal; the agent will adopt it.")
        : kind === "continuation"
          ? theme.fg("dim", "Automatic continuation; Esc pauses the goal.")
          : theme.fg("warning", "Budget reached; wrap up the current run."),
    ];
    if (options.expanded) {
      summary.push(
        "",
        theme.fg("dim", "Injected model guidance:"),
        buildGoalControlPrompt(kind, state),
      );
    } else {
      summary.push(theme.fg("dim", "(ctrl+o to show injected guidance)"));
    }
    box.addChild(new Text(summary.join("\n"), 0, 0));
    return box;
  });

  pi.registerTool({
    name: GET_GOAL_TOOL_NAME,
    label: "Get Goal",
    description: loadToolDescription("goal-get-tool"),
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      return {
        content: [{ type: "text" as const, text: formatGetGoalResult(goal) }],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: CREATE_GOAL_TOOL_NAME,
    label: "Create Goal",
    description: loadToolDescription("goal-create-tool"),
    parameters: Type.Object({
      objective: Type.String({
        minLength: 1,
        description: "Durable, evidence-checkable objective covering the outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition.",
      }),
      tokenBudget: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Optional positive token budget, only when explicitly requested." })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const objective = params.objective.trim();
      if (!objective) {
        return { content: [{ type: "text" as const, text: "objective is required." }], details: { goal }, isError: true };
      }
      const parsedBudget = normalizeTokenBudget(params.tokenBudget);
      if (parsedBudget.error) {
        return { content: [{ type: "text" as const, text: parsedBudget.error }], details: { goal }, isError: true };
      }
      const next = replaceGoal(ctx, objective, parsedBudget.tokenBudget, "model");
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ goal: next, remainingTokens: remainingTokens(next) }, null, 2) }],
        details: { goal: next },
      };
    },
  });

  pi.registerTool({
    name: UPDATE_GOAL_TOOL_NAME,
    label: "Update Goal",
    description: loadToolDescription("goal-update-tool"),
    parameters: Type.Object({
      status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
      reason: Type.String({
        minLength: 1,
        description: "Detailed rationale and concrete evidence supporting this completion or blocked status.",
      }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!goal) {
        return { content: [{ type: "text" as const, text: "No goal is set." }], details: { goal }, isError: true };
      }
      const budgetWrapup = isBudgetWrapup();
      if (goal.status !== "active" && !budgetWrapup) {
        return {
          content: [{ type: "text" as const, text: `Goal status is ${goal.status}; it cannot be updated by the model.` }],
          details: { goal },
          isError: true,
        };
      }
      if (budgetWrapup && params.status !== "complete") {
        return {
          content: [{ type: "text" as const, text: "A budget-limited goal can only be marked complete during its wrap-up." }],
          details: { goal },
          isError: true,
        };
      }
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      if (!reason) {
        return {
          content: [{ type: "text" as const, text: "reason is required and must not be blank." }],
          details: { goal },
          isError: true,
        };
      }
      const next: GoalState = { ...goal, status: params.status, updatedAt: Date.now() };
      setGoal(ctx, next);
      notify(ctx, params.status === "complete" ? "Goal marked complete." : "Goal marked blocked.", "info");
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ goal: next, remainingTokens: remainingTokens(next) }, null, 2) }],
        details: { goal: next },
      };
    },
  });

  pi.registerCommand("goal", {
    description: "Set, inspect, edit, pause, resume, or clear a long-running goal",
    getArgumentCompletions: (prefix) => {
      const values = ["status", "edit", "pause", "resume", "clear", "statusbar", "statusbar on", "statusbar off"];
      const matching = values.filter((value) => value.startsWith(prefix));
      return matching.length === 0 ? null : matching.map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      if (!sessionSupported || !isGoalSessionSupported(ctx)) {
        notify(ctx, "Goal mode is only available in the primary session.", "warning");
        return;
      }
      const trimmed = args.trim();
      if (!trimmed || trimmed === "status") {
        if (!goal) {
          notify(ctx, "Usage: /goal [--tokens 50k] <objective>");
          return;
        }
        notify(ctx, `${formatGoalStatus(goal)}\nObjective: ${goal.objective}\nUsage: ${formatGoalUsage(goal)}\nStatus bar: ${statusBarEnabled ? "on" : "off"}`);
        return;
      }

      if (trimmed === "statusbar" || trimmed === "statusbar on" || trimmed === "statusbar off") {
        const requested = trimmed.split(/\s+/, 2)[1];
        statusBarEnabled = requested === "on" ? true : requested === "off" ? false : !statusBarEnabled;
        generation++;
        persistSnapshot(ctx);
        notify(ctx, `Goal status bar ${statusBarEnabled ? "enabled" : "disabled"}.`);
        return;
      }

      if (trimmed === "clear") {
        if (!goal) {
          notify(ctx, "No goal is set.");
          return;
        }
        clearBudgetWrapup();
        setGoal(ctx, null);
        notify(ctx, "Goal cleared.");
        return;
      }

      if (trimmed === "pause") {
        if (!goal) {
          notify(ctx, "No goal is set.", "warning");
          return;
        }
        if (goal.status !== "active") {
          notify(ctx, `Goal is already ${goal.status}.`, "warning");
          return;
        }
        setGoal(ctx, { ...goal, status: "paused", updatedAt: Date.now() });
        notify(ctx, ctx.isIdle() ? "Goal paused." : "Goal paused; the current turn may finish unless interrupted with Esc.");
        return;
      }

      if (trimmed === "resume") {
        if (!goal) {
          notify(ctx, "No goal is set.", "warning");
          return;
        }
        if (goal.status === "complete") {
          notify(ctx, "Completed goals cannot be resumed; create a replacement goal.", "warning");
          return;
        }
        if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
          notify(ctx, "The goal token budget is exhausted; create a replacement goal with a new budget.", "warning");
          return;
        }
        if (goal.status !== "active") {
          setGoal(ctx, { ...goal, status: "active", updatedAt: Date.now() });
        }
        if (ctx.isIdle()) startContinuation(ctx);
        return;
      }

      if (trimmed === "edit" || trimmed.startsWith("edit ")) {
        if (!goal) {
          notify(ctx, "No goal is set.", "warning");
          return;
        }
        const objective = trimmed.slice("edit".length).trim();
        if (!objective) {
          notify(ctx, "Usage: /goal edit <objective>", "warning");
          return;
        }
        const next = { ...goal, objective, updatedAt: Date.now() };
        setGoal(ctx, next);
        if (next.status === "active") announceUserGoalSet(next);
        notify(ctx, "Goal objective updated.");
        return;
      }

      const parsed = parseTokenBudget(trimmed);
      if (parsed.error) {
        notify(ctx, parsed.error, "warning");
        return;
      }
      if (!parsed.objective) {
        notify(ctx, "Usage: /goal [--tokens 50k] <objective>", "warning");
        return;
      }
      if (goal && goal.status !== "complete" && ctx.hasUI) {
        const confirmed = await ctx.ui.confirm("Replace goal?", `Current: ${goal.objective}\n\nNew: ${parsed.objective}`);
        if (!confirmed) return;
      }
      replaceGoal(ctx, parsed.objective, parsed.tokenBudget, "user");
    },
  });

  pi.on("session_start", (event, ctx) => {
    generation++;
    clearContinuationTimer();
    sessionSupported = isGoalSessionSupported(ctx);
    if (!sessionSupported) {
      goal = null;
      runGoalId = null;
      settledRunGoalId = null;
      currentTurnStartedAt = null;
      lastStopReason = undefined;
      clearBudgetWrapup();
      updateStatus(ctx);
      syncGoalTools();
      return;
    }
    const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
      getBranch?: () => readonly unknown[];
      getEntries: () => readonly unknown[];
    };
    const restored = restoreGoalSnapshot(sessionManager.getBranch?.() ?? sessionManager.getEntries());
    goal = restored.goal;
    statusBarEnabled = restored.statusBarEnabled;
    runGoalId = null;
    settledRunGoalId = null;
    currentTurnStartedAt = null;
    lastStopReason = undefined;
    clearBudgetWrapup();
    if (goal?.status === "active" && event.reason === "reload") {
      setGoal(ctx, { ...goal, status: "paused", updatedAt: Date.now() });
      notify(ctx, `Goal paused after reload: ${truncateObjective(goal.objective)}\nUse /goal resume to continue.`);
      return;
    }
    updateStatus(ctx);
    syncGoalTools();
    if (goal?.status === "active") {
      notify(ctx, `Goal restored: ${truncateObjective(goal.objective)}\nAutomatic continuation will resume; Esc pauses it.`);
      scheduleContinuation(ctx);
    }
  });

  pi.on("session_shutdown", () => {
    generation++;
    clearContinuationTimer();
    runGoalId = null;
    settledRunGoalId = null;
    currentTurnStartedAt = null;
    lastStopReason = undefined;
    clearBudgetWrapup();
  });

  pi.on("before_agent_start", () => {
    if (!goal || goal.status !== "active") return undefined;
    // User-triggered runs pass through before_agent_start, unlike idle triggerTurn runs. Use the
    // same visible custom-message mechanism in both paths so model guidance is never invisible.
    return {
      message: {
        customType: GOAL_CONTROL_MESSAGE_TYPE,
        content: buildGoalContinuationPrompt(goal),
        display: true,
        details: { kind: "continuation", goal },
      },
    };
  });

  pi.on("agent_start", () => {
    clearContinuationTimer();
    runGoalId = goal?.status === "active" ? goal.id : null;
    settledRunGoalId = runGoalId;
    currentTurnStartedAt = null;
    lastStopReason = undefined;
  });

  pi.on("turn_start", () => {
    currentTurnStartedAt = Date.now();
  });

  pi.on("turn_end", (event, ctx) => {
    const assistant = event.message.role === "assistant" ? event.message as AssistantMessage : undefined;
    if (assistant) lastStopReason = assistant.stopReason;
    const elapsedSeconds = currentTurnStartedAt === null
      ? 0
      : Math.max(0, Math.round((Date.now() - currentTurnStartedAt) / 1000));
    currentTurnStartedAt = null;

    if (!goal || runGoalId !== goal.id || !assistant) return;
    const previousStatus = goal.status;
    const next = accountGoalTurn(goal, tokenDeltaFromUsage(assistant.usage), elapsedSeconds);
    const crossedBudget = previousStatus === "active" && next.status === "budget_limited";
    if (crossedBudget) {
      budgetWrapupGoalId = next.id;
      budgetToolTurnsSinceReminder = 0;
    }
    setGoal(ctx, next);

    if (assistant.stopReason === "aborted" && goal?.status === "active") {
      setGoal(ctx, { ...goal, status: "paused", updatedAt: Date.now() });
      notify(ctx, "Goal paused because the active turn was interrupted. Use /goal resume to continue.");
      return;
    }
    if (crossedBudget && goal) {
      emitControlMessage("budget_limit", goal, { deliverAs: "steer" });
    } else if (
      goal?.status === "budget_limited"
      && budgetWrapupGoalId === goal.id
      && assistant.stopReason === "toolUse"
    ) {
      budgetToolTurnsSinceReminder++;
      if (budgetToolTurnsSinceReminder >= BUDGET_REMINDER_INTERVAL) {
        budgetToolTurnsSinceReminder = 0;
        emitControlMessage("budget_limit", goal, { deliverAs: "steer" });
      }
    }
  });

  pi.on("agent_end", () => {
    runGoalId = null;
    currentTurnStartedAt = null;
  });

  pi.on("agent_settled", (_event, ctx) => {
    const finalRunGoalId = settledRunGoalId;
    settledRunGoalId = null;
    if (budgetWrapupGoalId !== null) {
      clearBudgetWrapup();
      syncGoalTools();
    }
    if (!goal || goal.status !== "active") return;
    const finalRunOwnsGoal = finalRunGoalId === goal.id;
    if (lastStopReason === "aborted" && finalRunOwnsGoal) {
      setGoal(ctx, { ...goal, status: "paused", updatedAt: Date.now() });
      notify(ctx, "Goal paused because the active turn was interrupted. Use /goal resume to continue.");
      return;
    }
    if (lastStopReason === "error" && finalRunOwnsGoal) {
      setGoal(ctx, {
        ...goal,
        status: "blocked",
        updatedAt: Date.now(),
      });
      notify(ctx, "Goal blocked because the final retry ended with an error. Inspect the error, then use /goal resume.", "warning");
      return;
    }
    startContinuation(ctx);
  });

  pi.on("session_compact", (event, ctx) => {
    if (event.reason === "manual" && !event.willRetry && goal?.status === "active") {
      scheduleContinuation(ctx);
    }
  });

  pi.on("context", (event) => {
    const messages = filterGoalContextMessages(
      event.messages,
      goal,
      budgetWrapupGoalId,
    );
    return messages === event.messages ? undefined : { messages };
  });

  return {
    getGoal: () => goal,
    getInjectedToolNames: (hasExplicitToolPolicy) => {
      if (!sessionSupported) return [];
      const tools: string[] = [];
      if (!hasExplicitToolPolicy) tools.push(CREATE_GOAL_TOOL_NAME);
      if (goalRuntimeToolsEnabled()) tools.push(GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME);
      return tools;
    },
  };
}

export function filterGoalContextMessages<T extends ContextMessageShape>(
  messages: T[],
  goal: GoalState | null,
  budgetWrapupGoalId: string | null,
): T[] {
  let latestControlIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.customType !== GOAL_CONTROL_MESSAGE_TYPE) continue;
    const details = isGoalControlDetails(message.details) ? message.details : undefined;
    const keepActiveControl = goal?.status === "active"
      && (details?.kind === "goal_set" || details?.kind === "continuation")
      && details.goal.id === goal.id;
    const keepBudgetWrapup = budgetWrapupGoalId !== null
      && details?.kind === "budget_limit"
      && details.goal.id === budgetWrapupGoalId;
    if (keepActiveControl || keepBudgetWrapup) {
      latestControlIndex = index;
      break;
    }
  }

  let changed = false;
  const filtered = messages.filter((message, index) => {
    if (message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error")) {
      changed = true;
      return false;
    }
    if (message.customType === GOAL_CONTROL_MESSAGE_TYPE && index !== latestControlIndex) {
      changed = true;
      return false;
    }
    return true;
  });
  return changed ? filtered : messages;
}

function remainingTokens(state: GoalState | null): number | null {
  if (!state || state.tokenBudget === null) return null;
  return Math.max(0, state.tokenBudget - state.tokensUsed);
}

function formatGetGoalResult(state: GoalState | null): string {
  const current = { goal: state, remainingTokens: remainingTokens(state) };
  if (!state) return `There is no current goal.\n\n${JSON.stringify(current, null, 2)}`;
  return [
    "This is the current goal. Use it to advance the objective or check whether every objective requirement is fully satisfied.",
    "Use update_goal only when the current goal status and evidence satisfy its tool policy.",
    "",
    "Current goal:",
    JSON.stringify(current, null, 2),
  ].join("\n");
}

function isGoalControlDetails(value: unknown): value is GoalControlDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Partial<GoalControlDetails>;
  return (details.kind === "goal_set" || details.kind === "continuation" || details.kind === "budget_limit")
    && details.goal !== null
    && typeof details.goal === "object"
    && typeof details.goal.id === "string";
}

function buildGoalControlPrompt(kind: GoalControlKind, state: GoalState): string {
  if (kind === "goal_set") return buildGoalSetPrompt(state);
  if (kind === "budget_limit") return buildGoalBudgetLimitPrompt(state);
  return buildGoalContinuationPrompt(state);
}

export type { GoalState, GoalStatus } from "./state.js";
