Read a text file, directory, or supported image by path.

Usage:
- Use `read` before editing an existing text file.
- For text files, the result starts with a small header (`path`, `ends_with_newline`, and `lsp`), then a blank line, then numbered lines in `number|content` form.
- When `column_offset` is greater than 1, the header also includes a `column_offset:` line so the first numbered line is not mistaken for a complete source line.
- Only the text after the first `|` on a numbered line is file content; the header lines and number column are not part of the file.
- `ends_with_newline: yes` means the file ends with a newline, even though `read` does not add an extra numbered blank line to represent it.
- Use `offset` and `limit` to read large files in chunks. Continue with subsequent chunks to cover new content; only read a wider window around a region when you need more local context.
- Follow the continuation notice at the end of a window: it names the exact next `offset`, plus `column_offset` when a long line was cut mid-line.
- `column_offset` is a 1-based Unicode code-point column and applies only to the first returned line; use it to continue reading a line that was cut at the 2000-code-point display cap.
- When a file is central to the task, keep reading in chunks until you have covered the whole relevant file.
- Use `read` on directories instead of `bash ls`.

Examples:
- `read({ path: "src/example.ts", workdir: "packages/web" })`
- `read({ path: "src/example.ts", workdir: "services/api", offset: 120, limit: 40 })`
- `read({ path: "src/example.ts", offset: 12, column_offset: 2001 })`
- `read({ path: "." })`
- `read({ path: "src/" })`
- `read({ path: "screenshot.png", workdir: "/tmp/agent-artifacts" })`
