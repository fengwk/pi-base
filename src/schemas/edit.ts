import { Type } from "@sinclair/typebox";

export const editSchema = Type.Object({
  path: Type.String({ description: "Existing text file to edit." }),
  edits: Type.Array(
    Type.Union([
      Type.Object({
        replace_lines: Type.Object({
          start_anchor: Type.String({ description: "Fresh `LINE:HASH` anchor for the first line in the replacement range." }),
          end_anchor: Type.String({ description: "Fresh `LINE:HASH` anchor for the last line in the replacement range." }),
          new_text: Type.String({ description: "Replacement text for the inclusive line range. Plain file content only; anchor prefixes belong only in anchor fields." }),
        }),
      }, { additionalProperties: false }),
      Type.Object({
        delete_lines: Type.Object({
          start_anchor: Type.String({ description: "Fresh `LINE:HASH` anchor for the first line in the deletion range." }),
          end_anchor: Type.String({ description: "Fresh `LINE:HASH` anchor for the last line in the deletion range." }),
        }),
      }, { additionalProperties: false }),
      Type.Object({
        insert_before: Type.Object({
          anchor: Type.String({ description: "Fresh `LINE:HASH` anchor before which new text will be inserted." }),
          new_text: Type.String({ description: "Complete line(s) to insert before the anchored line. The separating newline is added automatically when needed; anchor prefixes belong only in anchor fields." }),
        }),
      }, { additionalProperties: false }),
      Type.Object({
        insert_after: Type.Object({
          anchor: Type.String({ description: "Fresh `LINE:HASH` anchor after which new text will be inserted." }),
          new_text: Type.String({ description: "Complete line(s) to insert after the anchored line. The separating newline is added automatically when needed; anchor prefixes belong only in anchor fields." }),
        }),
      }, { additionalProperties: false }),
    ]),
    { description: "Anchored edit operations. This is an array. Each array item must contain exactly one operation: `replace_lines`, `delete_lines`, `insert_before`, or `insert_after`." },
  ),
});
