Go to the definition of a symbol at a given position.

Usage:
- Use `line` to identify the target line.
- `character` is optional. Default: `0`.
- `path` is required and should be a file path inside the target project/workspace, usually the file containing the symbol reference; it selects the relevant workspace/server.
- Prefer this for known-symbol navigation and third-party API inspection, not for broad repository text search.
- If definition lookup is unavailable for the selected server, the tool call returns a clear error; use `grep` or `read` to locate definitions manually.

Parameters:
- `path` (required)
- `workdir` (optional, default: the agent's current working directory; if provided, resolve from that directory)
- `line` (required, 1-based)
- `character` (optional, 0-based, default: 0)

Examples:
- `lsp_goto_definition({ path: "src/example.ts", workdir: "packages/web", line: 45, character: 15 })`
- `lsp_goto_definition({ path: "src/example.ts", line: 45 })`
