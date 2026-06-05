Search file contents and return matching lines.

Usage:
- Use `grep` for repository content search.
- Always pass an explicit `path`.
- Prefer narrowing the path or pattern before increasing `timeout_seconds`. The default timeout is usually sufficient, and explicitly setting a timeout is not recommended unless a broader scan is truly necessary.
- Treat `grep` as a candidate locator, not editing context. After `grep`, use `read` with targeted `offset`/`limit` to inspect enough surrounding code before editing.
- The content search respects `.gitignore`.
- When `path` is a single binary file, `grep` fails fast with a clear binary-file error instead of delegating to ripgrep.

Parameters:
- `pattern` (required)
- `path` (required)
- `include` (optional)
- `ignoreCase` (optional, default: false)
- `literal` (optional, default: false)
- `limit` (optional, default: 100)
- `timeout_seconds` (optional, default: 15)

Examples show the arguments passed to the tool:
- `{"pattern":"createDemoDirectory","path":"src","literal":true}`
- `{"pattern":"create.*Directory","path":"src","ignoreCase":true}`
- `{"pattern":"TODO","path":".","include":"**/*.ts","timeout_seconds":30}`
