import { Type } from "typebox";

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
      description: "Subagent type to run. Must be one of the names listed in the current system prompt's `<available_subagents>` section.",
    }),
    prompt: Type.String({
      description: "Complete, self-contained instructions for a new task, or updated direction and context for a resumed task. Include the objective, relevant scope, constraints, expected deliverable, output format, and verification instructions when applicable.",
    }),
    maxTurns: Type.Optional(Type.Integer({
      minimum: 1,
      description: `Positive integer interaction-turn budget for this invocation. Defaults to ${defaultMaxTurns}. If the child is unfinished when the budget is reached, it returns a phase report; use a smaller value when early path verification or frequent parent-child interaction is needed.`,
    })),
    session_id: Type.Optional(Type.String({
      description: "Identifier of a previous subagent session to resume, using the `<task id=\"...\">` value returned by an earlier task call.",
    })),
  });
}

/** Default export shape for type consumers; registered tools use the cwd-scoped factory above. */
export const taskSchema = createTaskSchema(50);
