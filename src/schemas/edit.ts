import { Type } from "typebox";

export const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)." }),
  edits: Type.Array(Type.Object({
    old_string: Type.String({ description: "Exact non-empty text to replace in the original file. Must match exactly once unless replace_all is true." }),
    new_string: Type.String({ description: "Replacement text. Must differ from old_string; may be empty to delete it." }),
    replace_all: Type.Optional(Type.Boolean({ description: "Replace all exact occurrences. Defaults to false." })),
  }, { additionalProperties: false }), {
    minItems: 1,
    description: "One or more independent replacements in this file. All match the original snapshot; overlaps or validation failures reject the entire call before writing.",
  }),
  workdir: Type.Optional(Type.String({ description: "Working directory for resolving relative paths. Defaults to the agent's current working directory. If provided, relative paths resolve from that directory." })),
}, { additionalProperties: false });
