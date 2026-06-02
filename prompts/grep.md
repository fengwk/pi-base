Search file contents and return edit-ready anchors.

Usage:
- Use `grep` for repository content search.
- Always pass an explicit `path`.
- Prefer narrowing the path or pattern before increasing `timeoutSeconds`. The default timeout is usually sufficient, and explicitly setting a timeout is not recommended unless a broader scan is truly necessary.
- Use `read` if you need more surrounding context.
- Underlying search engine is ripgrep. `.gitignore` is respected automatically (rg default behavior). `pi-base` does not add any implicit blacklist on top.
- When `path` is a single binary file, `grep` fails fast with a clear binary-file error instead of delegating to ripgrep.

Parameters:
- `pattern` (required)
- `path` (required)
- `include` (optional)
- `ignoreCase` (optional, default: false)
- `literal` (optional, default: false)
- `limit` (optional, default: 100)
- `timeoutSeconds` (optional, default: 15)

Examples:
- `grep({ pattern: "createDemoDirectory", path: "src", literal: true })`
- `grep({ pattern: "create.*Directory", path: "src", ignoreCase: true })`
- `grep({ pattern: "TODO", path: ".", include: "**/*.ts", timeoutSeconds: 30 })`
