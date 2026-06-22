Search symbols across the workspace by name.

Usage:
- Use this for known-symbol lookup when LSP is available.
- `path` is required because the LSP client uses it to infer the workspace root and choose the correct server.
- Prefer this when you already know or strongly suspect the symbol name.
- For broad repository source search, prefer `grep` because it is simpler and usually faster.
- If the server does not advertise `workspaceSymbolProvider` (e.g. `pylsp`), the call fails fast with a clear "does not advertise workspace/symbol support" message — use `grep` or `find` instead.

Parameters:
- `path` (required)
- `workdir` (optional, default: the agent's current working directory; if provided, resolve from that directory)
- `query` (required)
- `limit` (optional output limit, default: 50)

Examples use pseudo-code tool calls:
- `lsp_workspace_symbols({ path: "src/main/java/com/acme/App.java", workdir: "services/java", query: "UserService", limit: 20 })`
- `lsp_workspace_symbols({ path: "src/example.ts", query: "createDemoDirectory" })`
