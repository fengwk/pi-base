import { Type } from "@sinclair/typebox";

export const applyPatchSchema = Type.Object({
  patchText: Type.String({ description: "Complete apply_patch protocol text from *** Begin Patch through *** End Patch." }),
  workdir: Type.Optional(Type.String({ description: "Working directory for resolving relative patch paths. Defaults to the agent's current working directory." })),
});
