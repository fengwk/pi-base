# Base Tool Usage Guidance

- Prefer `read`, `grep`, `find`, `edit`, and `write` for repository file operations. Use `bash` only for build, test, git, package managers, external CLI commands, or tasks existing tools cannot satisfy, and pass `workdir` on every `bash` call.
- When moving or copying files, prefer `bash` with `mv` or `cp` instead of simulating copy/move operations by deleting or fully rewriting files.
- Read core files completely before important changes; if the default read limit is reached, continue reading in chunks.
- Parallel tool use is an important efficiency mechanism. When tool calls are independent and do not rely on each other, prefer issuing them in parallel. File mutations on the same file are serialized; unrelated reads, searches, and different-file mutations can still proceed concurrently.
- For existing text files, call `edit` with fresh `LINE:HASH` anchors from `read`, `grep`, or `write`. If `edit` reports a stale anchor, refresh the relevant file view before retrying. Replacement text is plain file content and must not include `LINE:HASH` prefixes.
- When citing line numbers, offsets, counts, or `LINE:HASH` anchors from tool output, copy them verbatim instead of inferring or reformatting them.
- Use `write` for new files or intentional whole-file replacement, and provide complete content without placeholders such as `...` or omitted sections.
- Prefer explicit file, directory, and search scopes. `grep` has a default `timeoutSeconds`; only set it explicitly when a broader scan is truly necessary. If it times out, narrow the path or pattern first. `find` requires an explicit `path`; use `.` when the intent really is the current working directory.
- Use repository file tools for repository content work and reserve `bash` for command execution.
- When `read` reports LSP support, use LSP tools for fast diagnostics, known-symbol navigation, and third-party API inspection when they fit the task. LSP tools require `path`, and that `path` is also used to infer the workspace root and select the correct server. For Java external definitions, prefer `lsp_java_decompile` over shell-based JAR extraction or manual decompilation.
- LSP servers are not built in. Define them under `lsp.servers` in `~/.pi/agent/pi-base/settings.json` (or `.pi/pi-base/settings.json`). `lsp.searchPaths` adds extra directories to the `PATH` scan. To "disable" a server, omit it.
- Few-shot examples:
  - Repository discovery: `find({ pattern: "*.ts", path: "src" })` -> `grep({ pattern: "createDemoDirectory", path: "src", literal: true })` -> `read({ path: "src/example.ts", offset: 40, limit: 20 })`
  - Local edit from fresh anchors: `read({ path: "src/example.ts" })` -> `edit({ path: "src/example.ts", edits: [{ replace_lines: { start_anchor: "45:4bf", end_anchor: "45:4bf", new_text: "export function buildDemoDirectory(): UserDirectory {" } }] })`
  - Parallel independent reads: `read({ path: "src/a.ts" })` and `read({ path: "src/b.ts" })` in parallel when the results do not depend on each other.
  - Java third-party inspection: `lsp_workspace_symbols({ path: "src/main/java/com/acme/App.java", query: "String", limit: 20 })` -> `lsp_java_decompile({ target: "jdt://contents/java.base/java/lang/String.class?...", path: "src/main/java/com/acme/App.java" })`
