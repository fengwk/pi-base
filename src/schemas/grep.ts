import { Type } from "@sinclair/typebox";

export const grepSchema = Type.Object({
  pattern: Type.String({ description: "Pattern to search for." }),
  path: Type.String({ description: "Directory or file path to search." }),
  workdir: Type.Optional(Type.String({ description: "Working directory for resolving relative paths. Defaults to the current working directory. If provided, relative paths resolve from that directory." })),
  include: Type.Optional(Type.String({ description: "Optional file filter glob such as `**/*.ts`." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search. Default: false." })),
  literal: Type.Optional(Type.Boolean({ description: "Treat the pattern literally instead of as a regular expression. Default: false." })),
  multiline: Type.Optional(Type.Boolean({ description: "Allow matches to span multiple lines by enabling ripgrep --multiline. Default: false." })),
  limit: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Maximum number of matches to return. Default: 100." })),
  timeout_seconds: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Search timeout in seconds. Default: 15." })),
});
