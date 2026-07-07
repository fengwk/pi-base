import { Type } from "@sinclair/typebox";

export const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)." }),
  old_string: Type.String({ description: "Exact text to replace. Must match exactly including whitespace and indentation. Must be unique in the file unless replace_all is true." }),
  new_string: Type.String({ description: "Replacement text (must differ from old_string)." }),
  replace_all: Type.Optional(Type.Boolean({ description: "Replace all exact occurrences of old_string (default false)." })),
  workdir: Type.Optional(Type.String({ description: "Working directory for resolving relative paths. Defaults to the agent's current working directory." })),
});
