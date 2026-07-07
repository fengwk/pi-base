Get diagnostics from the language server without running a build.

Usage:
- Use this for fast single-file checking when LSP is available.
- `path` is required and should be a file path inside the target project/workspace, usually the file you want diagnostics for; it selects the relevant workspace/server.
- Prefer this before large builds when you only need current-file errors or warnings.
- Run it again after edits when you need an updated view of the file.
- If the selected server cannot provide diagnostics, the call fails or times out clearly.

Parameters:
- `path` (required)
- `workdir` (optional, default: the agent's current working directory; if provided, resolve from that directory)
- `severity` (optional, one of `error`, `warning`, `information`, `hint`, `all`; default `all`)

Examples use pseudo-code tool calls:
- `lsp_diagnostics({ path: "src/main/java/com/acme/App.java", workdir: "services/java", severity: "error" })`
- `lsp_diagnostics({ path: "src/example.ts" })`
