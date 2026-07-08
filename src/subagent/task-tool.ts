import type { Static } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TASK_TOOL_NAME } from "./constants.js";
import { readDepth } from "./depth.js";
import { subagentRegistry } from "./registry.js";
import { formatRunResult, runSubagent, type SubagentSessionFactory } from "./runner.js";
import { taskSchema } from "./schema.js";
import { loadToolDescription, loadToolPromptSnippet } from "../tool-prompt.js";

export interface SubagentTaskToolDeps {
  /** Agents the currently-active agent may delegate to (its `subagents` allowlist). */
  getActiveAgentSubagents: () => string[];
  /** Whether an agent name exists in the loaded catalog (after invalid subagent filtering). */
  hasAgent: (name: string) => boolean;
  getMaxConcurrency: (cwd: string) => number;
  factory: SubagentSessionFactory;
}

const TASK_DESCRIPTION = loadToolDescription(TASK_TOOL_NAME);
const TASK_PROMPT_SNIPPET = loadToolPromptSnippet(TASK_TOOL_NAME);
const pendingSpawnReservations = new Map<string, number>();

function errorResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined; isError: true } {
  return { content: [{ type: "text", text: `Error: ${text}` }], details: undefined, isError: true };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatAvailableAgents(agentNames: string[]): string {
  return agentNames.length > 0 ? agentNames.join(" / ") : "no available agents";
}

function countPendingSpawnReservations(parentSessionId: string): number {
  return pendingSpawnReservations.get(parentSessionId) ?? 0;
}

function tryReserveSpawnSlot(parentSessionId: string, maxConcurrency: number): { active: number; release: () => void } | undefined {
  const running = subagentRegistry.runningChildCount(parentSessionId);
  const pending = countPendingSpawnReservations(parentSessionId);
  const active = running + pending;
  if (active >= maxConcurrency) return undefined;
  pendingSpawnReservations.set(parentSessionId, pending + 1);
  let released = false;
  return {
    active: active + 1,
    release: () => {
      if (released) return;
      released = true;
      const next = (pendingSpawnReservations.get(parentSessionId) ?? 0) - 1;
      if (next > 0) pendingSpawnReservations.set(parentSessionId, next);
      else pendingSpawnReservations.delete(parentSessionId);
    },
  };
}

/**
 * Register the `task` delegation tool. Validation order: required args -> known-agent check ->
 * subagents allowlist -> resume-not-running guard -> per-session concurrency cap. Then delegate
 * to `runSubagent`.
 */
export function registerSubagentTaskTool(pi: Pick<ExtensionAPI, "registerTool">, deps: SubagentTaskToolDeps): void {
  pi.registerTool({
    name: TASK_TOOL_NAME,
    label: "Task",
    description: TASK_DESCRIPTION,
    promptSnippet: TASK_PROMPT_SNIPPET,
    parameters: taskSchema,
    executionMode: "parallel",
    async execute(
      _toolCallId: string,
      params: Static<typeof taskSchema>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const agentType = readString(params?.subagent_type);
      const description = readString(params?.description);
      const prompt = readString(params?.prompt);
      const sessionId = readString(params?.session_id) || undefined;

      if (!agentType) return errorResult("`subagent_type` is required.");
      if (!prompt) return errorResult("`prompt` is required.");

      const allowed = deps.getActiveAgentSubagents();
      const availableAgents = formatAvailableAgents(allowed);
      if (!deps.hasAgent(agentType)) {
        return errorResult(`subagent_type "${agentType}" does not exist. Current available agents: ${availableAgents}.`);
      }
      if (!allowed.includes(agentType)) {
        return errorResult(
          `subagent_type "${agentType}" is not allowed. The current agent may delegate to: ${availableAgents}.`,
        );
      }

      const parentSessionId = ctx.sessionManager.getSessionId();
      let releaseSpawnReservation: (() => void) | undefined;
      if (sessionId) {
        const existing = subagentRegistry.get(sessionId);
        if (existing?.status === "running") {
          return errorResult(`subagent session "${sessionId}" is currently running; cannot resume until it finishes.`);
        }
      } else {
        const max = deps.getMaxConcurrency(ctx.cwd);
        const reservation = tryReserveSpawnSlot(parentSessionId, max);
        if (!reservation) {
          const active = subagentRegistry.runningChildCount(parentSessionId) + countPendingSpawnReservations(parentSessionId);
          return errorResult(
            `concurrency limit reached (${active}/${max} subagents running or starting). Wait for one to finish before delegating more.`,
          );
        }
        releaseSpawnReservation = reservation.release;
      }

      const childDepth = readDepth(ctx) + 1;
      try {
        const result = await runSubagent(
          ctx,
          {
            agentType,
            description,
            prompt,
            sessionId,
            childDepth,
            signal: signal ?? undefined,
            onRegistered: sessionId ? undefined : () => {
              releaseSpawnReservation?.();
              releaseSpawnReservation = undefined;
            },
          },
          deps.factory,
        );
        return { content: [{ type: "text" as const, text: formatRunResult(result) }], details: undefined, isError: result.state === "error" };
      } finally {
        releaseSpawnReservation?.();
      }
    },
  });
}
