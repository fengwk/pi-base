import { Type } from "@sinclair/typebox";

export const writeSchema = Type.Object({
  path: Type.String({ description: "File path to create or overwrite." }),
  workdir: Type.String({ description: "Working directory for resolving relative paths. Required. Use '.' for the current working directory." }),
  content: Type.String({ description: "Complete file content." }),
});
