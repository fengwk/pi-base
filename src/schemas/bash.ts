import { Type } from "typebox";

export const bashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute." }),
  workdir: Type.Optional(Type.String({ description: "Working directory for the command. Defaults to the agent's current working directory. If provided, the command runs from that directory and relative paths in the command resolve from it. Prefer this over embedding `cd ... &&` in `command`." })),
  timeout_seconds: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Positive timeout in seconds. Defaults to 120 (2 minutes). For commands that may run longer, provide a larger value." })),
});
