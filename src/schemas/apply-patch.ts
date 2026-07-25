import { Type } from "@sinclair/typebox";

/**
 * Freeform apply_patch input. On grammar-capable models this is sampled as a
 * custom tool argument constrained by APPLY_PATCH_LARK_GRAMMAR; the single
 * string field is the entire patch text (optional Workdir header included).
 */
export const applyPatchSchema = Type.Object({
  patchText: Type.String({
    description:
      "Complete apply_patch freeform text from *** Begin Patch through *** End Patch. Optional first directive: *** Workdir: <path> (defaults to the session cwd).",
  }),
}, { additionalProperties: false });
