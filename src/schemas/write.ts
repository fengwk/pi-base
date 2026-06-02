import { Type } from "@sinclair/typebox";

export const writeSchema = Type.Object({
  path: Type.String({ description: "File path to create or overwrite." }),
  content: Type.String({ description: "Complete file content." }),
});
