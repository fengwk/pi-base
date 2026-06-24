import { Type } from "@sinclair/typebox";

export const editSchema = Type.Object({
  workdir: Type.Optional(Type.String({ description: "Working directory for resolving relative paths inside hashline section headers. Defaults to the agent's current working directory." })),
  input: Type.String({ description: "Explicit-range hashline patch input. Use `[path#TAG]` section headers and only `SWAP`, `DEL`, `INS.PRE`, `INS.POST`, `INS.HEAD`, and `INS.TAIL` operations exactly as documented by the tool prompt." }),
});
