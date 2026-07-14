import { Type } from "@sinclair/typebox";

export const applyPatchSchema = Type.Object({
  patchText: Type.String({ description: "Complete apply_patch protocol text from *** Begin Patch through *** End Patch." }),
});
