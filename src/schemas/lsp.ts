import { Type } from "@sinclair/typebox";

export const lspDiagnosticsSchema = Type.Object({
  path: Type.String({ description: "Existing source file path supported by an LSP server. This path is also used to infer the workspace root." }),
  severity: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("information"), Type.Literal("hint"), Type.Literal("all")], { description: "Optional severity filter. Default: `all`." })),
});

export const lspGotoDefinitionSchema = Type.Object({
  path: Type.String({ description: "Existing source file path supported by an LSP server. This path is also used to infer the workspace root." }),
  line: Type.Integer({ minimum: 1, description: "1-based line number for the target position." }),
  character: Type.Optional(Type.Integer({ minimum: 0, description: "0-based character offset at the target position. Default: 0." })),
});

export const lspWorkspaceSymbolsSchema = Type.Object({
  path: Type.String({ description: "Existing source file path used to resolve the workspace root." }),
  query: Type.String({ description: "Symbol search query." }),
  limit: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum number of results to display locally. Default: 50." })),
});

export const lspJavaDecompileSchema = Type.Object({
  target: Type.String({ description: "A raw `jdt://` URI, a workspace symbol output line, or a `file://` / `.class` path." }),
  path: Type.String({ description: "Any local `.java` file in the target workspace. This path is used to infer the workspace root and locate JDTLS." }),
});
