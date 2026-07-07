import { Type } from "@sinclair/typebox";

export const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)." }),
  oldString: Type.String({ description: "Exact text to replace. Must match exactly including whitespace and indentation. Must be unique in the file unless replaceAll is true." }),
  newString: Type.String({ description: "Replacement text (must differ from oldString)." }),
  replaceAll: Type.Optional(Type.Boolean({ description: "Replace all exact occurrences of oldString (default false)." })),
  workdir: Type.Optional(Type.String({ description: "Working directory for resolving relative paths. Defaults to the agent's current working directory." })),
});
