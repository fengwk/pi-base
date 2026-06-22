import { Type } from "@sinclair/typebox";

export const writeSchema = Type.Object({
  path: Type.String({ description: "File path to create or intentionally overwrite as a whole file." }),
  workdir: Type.Optional(Type.String({ description: "Working directory for resolving relative paths. Defaults to the current working directory. If provided, relative paths resolve from that directory." })),
  content: Type.String({ description: "Complete file content." }),
});
