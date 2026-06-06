Find files by glob pattern in an explicit path.

Usage:
- Use `find` to discover files by name or path pattern, not to search file contents.
- `path` is required; there is no implicit search root. Use `.` only when the intent really is the current working directory.
- The underlying file search respects `.gitignore`.
- Use `grep` after `find` when you need content search inside the discovered scope.
- `timeout_seconds` is optional and only needed when a broad file discovery may legitimately take longer than expected.

Parameters:
- `pattern` (required)
- `path` (required)
- `workdir` (required)
- `limit` (optional, default: 1000)
- `timeout_seconds` (optional, no default)

Examples show the arguments passed to the tool:
- `{"pattern":"*.ts","path":"src","workdir":"packages/web"}`
- `{"pattern":"*.java","path":".","workdir":"services/java","limit":200}`
- `{"pattern":"*.md","path":".","workdir":".","timeout_seconds":30}`
