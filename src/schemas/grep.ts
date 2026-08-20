import { Type } from "typebox";

export const grepSchema = Type.Object({
  pattern: Type.String({ description: "Regular-expression pattern to search for by default; use literal=true to treat it as exact text." }),
  path: Type.String({ description: "Directory or file path to search." }),
  workdir: Type.Optional(Type.String({ description: "Working directory for resolving relative paths. Defaults to the agent's current working directory. If provided, relative paths resolve from that directory." })),
  include: Type.Optional(Type.String({ description: "Optional file filter glob such as `**/*.ts`." })),
  ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive search. Defaults to false." })),
  literal: Type.Optional(Type.Boolean({ description: "Treat the pattern literally instead of as a regular expression. Defaults to false." })),
  multiline: Type.Optional(Type.Boolean({ description: "Allow matches to span multiple lines by enabling ripgrep --multiline. Defaults to false." })),
  limit: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Positive maximum number of matches to return. Defaults to 100." })),
  timeout_seconds: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Positive search timeout in seconds. Defaults to 15." })),
});
