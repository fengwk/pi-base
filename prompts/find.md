Find files by glob pattern in an explicit path.

Usage:
- Use `find` to discover files by name or path pattern, not to search file contents.
- `path` is required; there is no implicit search root. Use `.` only when the intent really is the current working directory.
- A glob without `/`, such as `*.ts`, matches names at any depth under `path`. A relative glob with `/` matches paths relative to `path`: `src/*.ts` matches direct entries in the root's `src`, while `**/src/*.ts` matches direct entries in `src` directories at any depth under the root.
- A leading `./` is ignored and does not limit depth: `./*.ts` is the same as `*.ts`.
- The underlying file search respects `.gitignore`.
- Use `grep` after `find` when you need content search inside the discovered scope.
- `timeout_seconds` is optional and only needed when a broad file discovery may legitimately take longer than expected.
- Do not search from broad roots such as `/`, `~`, or `$HOME`.

Examples:
- `find({ pattern: "src/*.ts", path: "." })` — direct TypeScript files in the search root's `src`.
- `find({ pattern: "**/src/*.ts", path: "." })` — direct TypeScript files in `src` directories across modules.
- `find({ pattern: "*.ts", path: "src", workdir: "packages/web" })`
- `find({ pattern: "*.java", path: "src", workdir: "services/java", limit: 200 })`
- `find({ pattern: "*.md", path: "docs", timeout_seconds: 30 })`
