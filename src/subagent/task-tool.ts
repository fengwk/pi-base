import type { Static } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TASK_TOOL_NAME } from "./constants.js";
import { readDepth } from "./depth.js";
import { subagentRegistry } from "./registry.js";
import { formatRunResult, runSubagent, type SubagentSessionFactory } from "./runner.js";
import { taskSchema } from "./schema.js";

export interface SubagentTaskToolDeps {
  /** Agents the currently-active agent may delegate to (its `subagents` allowlist). */
  getActiveAgentSubagents: () => string[];
  getMaxConcurrency: (cwd: string) => number;
  factory: SubagentSessionFactory;
}

const TASK_DESCRIPTION = [
  "Delegate a self-contained task to a subagent that runs autonomously in an isolated session and returns a single final report.",
  "Set `subagent_type` to one of the agents listed in the Subagents section of the system prompt; if none fits, do the work yourself with other tools.",
  "",
  "Usage notes:",
  "1. To run several subagents at once, emit multiple task calls in a single message — they execute concurrently.",
  "2. Give a highly detailed, self-contained prompt and state exactly what the subagent should return; it does not see the user's intent.",
  "3. Say whether you want code changes or just research, and how to verify the work if possible.",
  "4. Each call starts a fresh subagent unless you pass `session_id` to resume a previous one (continues its prior messages/tools).",
  "5. The report is returned to you but is NOT shown to the user; summarize it yourself. The result includes the `session_id` for resuming later.",
].join("\n");

function errorResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined; isError: true } {
  return { content: [{ type: "text", text: `Error: ${text}` }], details: undefined, isError: true };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Register the `task` delegation tool. Validation order: required args -> subagents allowlist ->
 * resume-not-running guard -> per-session concurrency cap. Then delegate to `runSubagent`.
 */
export function registerSubagentTaskTool(pi: Pick<ExtensionAPI, "registerTool">, deps: SubagentTaskToolDeps): void {
  pi.registerTool({
    name: TASK_TOOL_NAME,
    label: "Task",
    description: TASK_DESCRIPTION,
    promptSnippet: "task: delegate a task to a subagent and get its report (session-isolated).",
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
      if (!allowed.includes(agentType)) {
        return errorResult(
          `subagent_type "${agentType}" is not allowed. The current agent may delegate to: [${allowed.join(", ") || "(none)"}].`,
        );
      }

      if (sessionId) {
        const existing = subagentRegistry.get(sessionId);
        if (existing?.status === "running") {
          return errorResult(`subagent session "${sessionId}" is currently running; cannot resume until it finishes.`);
        }
      } else {
        const parentSessionId = ctx.sessionManager.getSessionId();
        const running = subagentRegistry.runningChildCount(parentSessionId);
        const max = deps.getMaxConcurrency(ctx.cwd);
        if (running >= max) {
          return errorResult(
            `concurrency limit reached (${running}/${max} subagents running). Wait for one to finish before delegating more.`,
          );
        }
      }

      const childDepth = readDepth(ctx) + 1;
      const result = await runSubagent(
        ctx,
        { agentType, description, prompt, sessionId, childDepth, signal: signal ?? undefined },
        deps.factory,
      );
      return { content: [{ type: "text" as const, text: formatRunResult(result) }], details: undefined, isError: result.state === "error" };
    },
  });
}

