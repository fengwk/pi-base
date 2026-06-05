Search symbols across the workspace by name.

Usage:
- Use this for known-symbol lookup when LSP is available.
- `path` is required because the LSP client uses it to infer the workspace root and choose the correct server.
- Prefer this when you already know or strongly suspect the symbol name.
- For broad repository source search, prefer `grep` because it is simpler and usually faster.
- If the server does not advertise `workspaceSymbolProvider` (e.g. `pylsp`), the call fails fast with a clear "does not advertise workspace/symbol support" message — use `grep` or `find` instead.

Parameters:
- `path` (required)
- `query` (required)
- `limit` (optional output limit, default: 50)

Examples show the arguments passed to the tool:
- `{"path":"src/main/java/com/acme/App.java","query":"UserService","limit":20}`
- `{"path":"src/example.ts","query":"createDemoDirectory"}`
