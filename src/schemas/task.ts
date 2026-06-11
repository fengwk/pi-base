import { Type } from "@sinclair/typebox";

export const taskSchema = Type.Object({
  subagent: Type.String({
    description: "Exact subagent name to run. Use one of the <name> values from the system prompt's <available_subagents> block; do not invent a new name.",
    minLength: 1,
  }),
  prompt: Type.String({
    description: "Complete instructions for the delegated subtask. Include all required context, the goal, constraints, and the expected report format.",
    minLength: 1,
  }),
  session_id: Type.Optional(Type.String({
    description: "Optional subagent session id to continue. Omit it to start a new subagent session.",
    minLength: 1,
  })),
});
