Get diagnostics from the language server without running a build.

Usage:
- Use this for fast single-file checking when LSP is available.
- `path` is required because the LSP client uses it to infer the workspace root and choose the correct server.
- Prefer this before large builds when you only need current-file errors or warnings.
- After a successful `edit` or `write`, the LSP layer will sync already-open files before diagnostics are requested again.
- If a server does not actually support diagnostics, the configured `requestTimeoutMs` will surface that as a timeout error rather than the call returning silently with no data.
- This tool does not pre-check server capabilities. For most servers it first tries `textDocument/diagnostic`, then falls back to waiting for pushed diagnostics with a configurable timeout; for `jdtls` it waits for `publishDiagnostics` directly because that path is more reliable in practice.

Parameters:
- `path` (required)
- `workdir` (required)
- `severity` (optional, one of `error`, `warning`, `information`, `hint`, `all`; default `all`)

Examples use pseudo-code tool calls:
- `lsp_diagnostics({ path: "src/main/java/com/acme/App.java", workdir: "services/java", severity: "error" })`
- `lsp_diagnostics({ path: "src/example.ts", workdir: "packages/web" })`
