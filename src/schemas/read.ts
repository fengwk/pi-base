import { Type } from "typebox";

export const readSchema = Type.Object({
  path: Type.String({ description: "File, directory, or supported image path to read." }),
  workdir: Type.Optional(Type.String({ description: "Working directory for resolving relative paths. Defaults to the agent's current working directory. If provided, relative paths resolve from that directory." })),
  offset: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Positive integer 1-based line offset for text reads. Defaults to 1." })),
  limit: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Positive integer maximum number of text lines to return. Defaults to 200 and must not exceed 2000." })),
});
