Go to the definition of a symbol at a given position.

Usage:
- Use `line` to identify the target line.
- `character` is optional. Default: `0`.
- `path` is required because the LSP client uses it to infer the workspace root and choose the correct server.
- Prefer this for known-symbol navigation and third-party API inspection, not for broad repository text search.
- If the server does not advertise `definitionProvider`, the call fails fast with a clear "does not advertise go-to-definition" message — use `grep` or `read` to locate definitions manually.

Parameters:
- `path` (required)
- `workdir` (optional, default: current working directory; if provided, resolve from that directory)
- `line` (required, 1-based)
- `character` (optional, 0-based, default: 0)

Examples use pseudo-code tool calls:
- `lsp_goto_definition({ path: "src/example.ts", workdir: "packages/web", line: 45, character: 15 })`
- `lsp_goto_definition({ path: "src/example.ts", line: 45 })`
