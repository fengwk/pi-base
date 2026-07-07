Decompile a Java external class using JDTLS.

Usage:
- **Only works against `jdtls`.** If the selected workspace is not backed by `jdtls`, the call fails clearly.
- Prefer this over shell-based JAR extraction or manual decompilation.
- Pass a raw `jdt://...` URI or a full workspace symbol / definition output line when available.
- `path` is required and should be a file path inside the target Java project/workspace, usually the file you are currently working from; it selects the relevant Java workspace.
- Prefer the sequence `lsp_workspace_symbols` or `lsp_goto_definition` -> `lsp_java_decompile` for third-party Java classes.
- Use this only for Java external definitions; for local source files, prefer `read` or `lsp_goto_definition` directly.

Parameters:
- `path` (required)
- `workdir` (optional, default: the agent's current working directory; if provided, resolve from that directory)
- `target` (required)

Examples use pseudo-code tool calls:
- `lsp_java_decompile({ path: "src/main/java/com/acme/App.java", workdir: "services/java", target: "jdt://contents/java.base/java/lang/String.class?..." })`
- `lsp_java_decompile({ path: "src/main/java/com/acme/App.java", target: "String (Class) - jdt://contents/java.base/java/lang/String.class?..." })`
