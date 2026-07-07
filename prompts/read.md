Read a text file, directory, or supported image by path.

Usage:
- Use `read` before editing an existing text file.
- For text files, the result starts with a small header (`path`, `total_lines`, `ends_with_newline`, and sometimes `lsp`), then a blank line, then numbered lines in `number|content` form.
- Only the text after the first `|` on a numbered line is file content; the header lines and number column are not part of the file.
- `ends_with_newline: yes` means the file ends with a newline, even though `read` does not add an extra numbered blank line to represent it.
- Use `offset` and `limit` to read large files in chunks. Continue with subsequent chunks to cover new content; only read a wider window around a region when you need more local context.
- When a file is central to the task, keep reading in chunks until you have covered the whole relevant file.
- Use `read` on directories instead of `bash ls`.

Parameters:
- `path` (required)
- `workdir` (optional, default: the agent's current working directory; if provided, resolve from that directory)
- `offset` (optional, default: 1)
- `limit` (optional, default: 200, max: 2000)

Examples:
- `read({ path: "src/example.ts", workdir: "packages/web" })`
- `read({ path: "src/example.ts", workdir: "services/api", offset: 120, limit: 40 })`
- `read({ path: "." })`
- `read({ path: "src/" })`
- `read({ path: "screenshot.png", workdir: "/tmp/agent-artifacts" })`
