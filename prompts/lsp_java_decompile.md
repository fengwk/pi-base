Decompile a Java external class using JDTLS.

Usage:
- **Only works against `jdtls`.** Calling it on a non-jdtls server (e.g. `pylsp`) fails fast with a clear "only supported by jdtls" message.
- Prefer this over shell-based JAR extraction or manual decompilation.
- Pass a raw `jdt://...` URI or a full workspace symbol / definition output line when available.
- `path` is required because the LSP client uses it to infer the workspace root and locate the correct Java workspace.
- Prefer the sequence `lsp_workspace_symbols` or `lsp_goto_definition` -> `lsp_java_decompile` for third-party Java classes.
- Use this only for Java external definitions; for local source files, prefer `read` or `lsp_goto_definition` directly.

Parameters:
- `path` (required)
- `workdir` (required)
- `target` (required)

Examples show the arguments passed to the tool:
- `{"path":"src/main/java/com/acme/App.java","workdir":"services/java","target":"jdt://contents/java.base/java/lang/String.class?..."}`
- `{"path":"src/main/java/com/acme/App.java","workdir":"services/java","target":"String (Class) - jdt://contents/java.base/java/lang/String.class?..."}`
