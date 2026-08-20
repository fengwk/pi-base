import { Type } from "typebox";

export const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)." }),
  old_string: Type.String({ description: "Exact non-empty text to replace. It must match file content exactly, including whitespace and indentation, and must occur exactly once unless replace_all is true." }),
  new_string: Type.String({ description: "Replacement text. It must differ from old_string and may be empty to delete the matched text." }),
  replace_all: Type.Optional(Type.Boolean({ description: "Replace every exact occurrence of old_string. Defaults to false." })),
  workdir: Type.Optional(Type.String({ description: "Working directory for resolving relative paths. Defaults to the agent's current working directory. If provided, relative paths resolve from that directory." })),
});
