Find files by glob pattern in an explicit path.

Usage:
- Use `find` to discover files by name or path pattern, not to search file contents.
- `path` is required; there is no implicit search root. Use `.` only when the intent really is the current working directory.
- The underlying file search respects `.gitignore`.
- Use `grep` after `find` when you need content search inside the discovered scope.

Parameters:
- `pattern` (required)
- `path` (required)
- `limit` (optional, default: 1000)

Examples:
- `find({ pattern: "*.ts", path: "src" })`
- `find({ pattern: "*.java", path: ".", limit: 200 })`
