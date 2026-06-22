import { Type } from "@sinclair/typebox";

export const readSchema = Type.Object({
  path: Type.String({ description: "File, directory, or supported image path to read." }),
  workdir: Type.Optional(Type.String({ description: "Working directory for resolving relative paths. Defaults to the current working directory. If provided, relative paths resolve from that directory." })),
  offset: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "1-based line offset for text reads. Default: 1." })),
  limit: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Maximum number of text lines to return. Default: 200. Maximum: 2000." })),
});
