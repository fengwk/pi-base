import { Type } from "@sinclair/typebox";

/**
 * `task` delegation tool schema.
 *
 * `subagent_type` is always required (which agent to run). `session_id` is optional:
 * when provided, the existing subagent session is resumed; if `subagent_type` differs
 * from that session's current agent, the session is switched to the latest config of
 * the new type (see design.md §5.1).
 */
export function createTaskSchema(defaultMaxTurns: number) {
  return Type.Object({
    subagent_type: Type.String({
      description: "Which subagent to delegate to. Must be listed in the current agent's `subagents` allowlist.",
    }),
    prompt: Type.String({
      description: "The full task/instructions handed to the subagent.",
    }),
    maxTurns: Type.Optional(Type.Integer({
      minimum: 1,
      description: `Optional positive interaction-turn budget for this invocation. Default: ${defaultMaxTurns}. If unfinished at the budget, the child returns a phase report; use a smaller budget to verify its path early or when frequent parent-child interaction is needed.`,
    })),
    session_id: Type.Optional(Type.String({
      description: "Resume a previous subagent session by its id (the `<task id=\"...\">` value returned from an earlier task call).",
    })),
  });
}

/** Default export shape for type consumers; registered tools use the cwd-scoped factory above. */
export const taskSchema = createTaskSchema(50);
