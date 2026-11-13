Search file contents and return matching lines.

Usage:
- Use `grep` for repository content search.
- Always pass an explicit `path`.
- Prefer narrowing the path or pattern before increasing `timeout_seconds`. The default timeout is usually sufficient, and explicitly setting a timeout is not recommended unless a broader scan is truly necessary.
- Treat `grep` results as candidate locations, not editing context. After `grep`, use `read` with targeted `offset`/`limit` to inspect enough surrounding code before editing.
- The content search respects `.gitignore`.
- When `path` is a single binary file, `grep` returns a clear error instead of binary output.
- Files that declare a legacy encoding are searched on their decoded text, so matches agree with `read`.
- A final `Not searched because the text encoding could not be determined:` notice lists files that were skipped; their content was not checked, so convert them to UTF-8 or add a standard declaration and search again.
- `pattern` is a regular expression by default; use `literal=true` for exact text.
- `multiline=true` enables matching across line breaks. Use it when the pattern contains an actual newline or the regex newline escape `\n`; in JSON/tool-call payloads that regex escape is written as `\\n`.
- Do not search from broad roots such as `/`, `~`, or `$HOME`.

Examples:
- `grep({ pattern: "createDemoDirectory", path: "src", workdir: "packages/web", literal: true })`
- `grep({ pattern: "create.*Directory", path: "src", workdir: "services/api", ignore_case: true })`
- `grep({ pattern: "TODO", path: "src", include: "**/*.ts", timeout_seconds: 30 })`
- `grep({ pattern: "start\\nend", path: "src", multiline: true })`
