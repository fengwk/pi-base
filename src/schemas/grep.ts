import { Type } from "@sinclair/typebox";

export const grepSchema = Type.Object({
  pattern: Type.String({ description: "Pattern to search for." }),
  path: Type.String({ description: "Directory or file path to search." }),
  include: Type.Optional(Type.String({ description: "Optional file filter glob such as `**/*.ts`." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search. Default: false." })),
  literal: Type.Optional(Type.Boolean({ description: "Treat the pattern literally instead of as a regular expression. Default: false." })),
  limit: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Maximum number of matches to return. Default: 100." })),
  timeoutSeconds: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Search timeout in seconds. Default: 15." })),
});
