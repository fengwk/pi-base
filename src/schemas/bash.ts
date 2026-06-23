import { Type } from "@sinclair/typebox";

export const bashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute." }),
  workdir: Type.Optional(Type.String({ description: "Working directory for the command. Defaults to the agent's current working directory. If provided, the command runs from that directory. Prefer this over embedding `cd ... &&` in `command` when you need a different directory." })),
  timeout_seconds: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Optional timeout in seconds. Defaults to 120 (2 minutes). For long-running commands, explicitly provide a larger value." })),
});
