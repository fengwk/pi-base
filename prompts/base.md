# Base Tool Usage Guidance

- Prefer `read`, `grep`, `find`, `edit`, and `write` for repository file operations. Use `bash` only for build, test, git, package managers, external CLI commands, or tasks existing tools cannot satisfy.
- When moving or copying files, prefer `bash` with `mv` or `cp` instead of simulating copy/move operations by deleting or fully rewriting files.
- For exploration, prefer `grep` plus targeted partial `read` calls to locate relevant code efficiently. Before modifying core code, read the full file or enough related context to avoid missing relevant behavior; read in chunks when needed.
- Parallel tool use is an important efficiency mechanism. When tool calls are independent and do not rely on each other, prefer issuing them in parallel. Unrelated reads, searches, and different-file mutations can still proceed concurrently.
- For multiple changes to the same file, prefer one `edit` call with multiple operations when possible.
- For existing text files, call `edit` with fresh `LINE:HASH` anchors from `read`, `grep`, or `write`. If `edit` reports a stale anchor, rerun `read` for the relevant region before retrying. Replacement text is plain file content and must not include `LINE:HASH` prefixes.
- If a prior tool result is replaced with a pi-base context compression placeholder, do not treat the placeholder as original tool output. Re-run the appropriate tool before relying on omitted details, file content, or `LINE:HASH` anchors.
- When citing line numbers, offsets, counts, or `LINE:HASH` anchors from tool output, copy them verbatim instead of inferring or reformatting them.
- Prefer `edit` for existing text files. Use `write` only for new files or intentional large whole-file rewrites, and provide complete content without placeholders such as `...` or omitted sections.
- Prefer explicit file, directory, and search scopes. `grep` has a default `timeoutSeconds`; only set it explicitly when a broader scan is truly necessary. If it times out, narrow the path or pattern first. `find` requires an explicit `path`; use `.` when the intent really is the current working directory.
- Use repository file tools for repository content work and reserve `bash` for command execution.
- When `read` reports LSP support, use LSP tools for fast diagnostics, known-symbol navigation, and third-party API inspection when they fit the task. LSP tools require `path`, and that `path` is also used to infer the workspace root and select the correct server. For Java external definitions, prefer `lsp_workspace_symbols` or `lsp_goto_definition` to discover the class target, then pass that result to `lsp_java_decompile` instead of using shell-based JAR extraction or manual decompilation.
- Few-shot examples:
  - Repository discovery: `find({ pattern: "*.ts", path: "src" })` -> `grep({ pattern: "createDemoDirectory", path: "src", literal: true })` -> `read({ path: "src/example.ts", offset: 40, limit: 20 })`
  - Local edit from fresh anchors: `read({ path: "src/example.ts" })` -> `edit({ path: "src/example.ts", edits: [{ replace_lines: { start_anchor: "45:4bf", end_anchor: "45:4bf", new_text: "export function buildDemoDirectory(): UserDirectory {" } }] })`
  - Parallel independent reads: `read({ path: "src/a.ts" })` and `read({ path: "src/b.ts" })` in parallel when the results do not depend on each other.
  - Java third-party inspection: `lsp_workspace_symbols({ path: "src/main/java/com/acme/App.java", query: "String", limit: 20 })` -> `lsp_java_decompile({ path: "src/main/java/com/acme/App.java", target: "jdt://contents/java.base/java/lang/String.class?..." })`
