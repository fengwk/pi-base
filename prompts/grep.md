Search file contents and return matching lines.

Usage:
- Use `grep` for repository content search.
- Always pass an explicit `path`.
- Prefer narrowing the path or pattern before increasing `timeout_seconds`. The default timeout is usually sufficient, and explicitly setting a timeout is not recommended unless a broader scan is truly necessary.
- Treat `grep` as a candidate locator, not editing context. After `grep`, use `read` with targeted `offset`/`limit` to inspect enough surrounding code before editing.
- The content search respects `.gitignore`.
- When `path` is a single binary file, `grep` fails fast with a clear binary-file error instead of delegating to ripgrep.
- `multiline=true` enables ripgrep multiline mode for patterns that must match across line breaks. Use it when the pattern contains an actual newline or the regex newline escape `\n`; in JSON/tool-call payloads that regex escape is written as `\\n`.

Parameters:
- `pattern` (required)
- `path` (required)
- `workdir` (required)
- `include` (optional)
- `ignoreCase` (optional, default: false)
- `literal` (optional, default: false)
- `multiline` (optional, default: false)
- `limit` (optional, default: 100)
- `timeout_seconds` (optional, default: 15)

Examples use pseudo-code tool calls:
- `grep({ pattern: "createDemoDirectory", path: "src", workdir: "packages/web", literal: true })`
- `grep({ pattern: "create.*Directory", path: "src", workdir: "services/api", ignoreCase: true })`
- `grep({ pattern: "TODO", path: ".", workdir: ".", include: "**/*.ts", timeout_seconds: 30 })`
- `grep({ pattern: "start\\nend", path: "src", workdir: ".", multiline: true })`
