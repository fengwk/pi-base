import { Type } from "@sinclair/typebox";

export const bashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute." }),
  workdir: Type.String({ description: "Working directory for the command. Required. Use this instead of embedding `cd` in `command`." }),
  timeout_seconds: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Optional timeout in seconds. No default timeout." })),
});
