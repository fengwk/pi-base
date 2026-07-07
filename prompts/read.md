Read a text file, directory, or supported image by path.

Usage:
- Use `read` before editing an existing text file.
- For text files, the result starts with metadata lines (`path`, `kind`, `encoding`, `bom`, `line_endings`, `final_newline`), then a blank line, then numbered lines: `<line>: <content>`.
- Only the numbered body is file content; the metadata lines are not part of the file.
- Use the metadata when BOM, line-ending style, or whether the file ends with a newline matters.
- Use `offset` and `limit` to read large files in chunks. Re-read with a wider window to see more lines.
- Use `read` on directories instead of `bash ls`.

Parameters:
- `path` (required)
- `workdir` (optional, default: the agent's current working directory; if provided, resolve from that directory)
- `offset` (optional, default: 1)
- `limit` (optional, default: 200, max: 2000)

Examples use pseudo-code tool calls:
- `read({ path: "src/example.ts", workdir: "packages/web" })`
- `read({ path: "src/example.ts", workdir: "services/api", offset: 120, limit: 40 })`
- `read({ path: "." })`             // list directory
- `read({ path: "src/" })`          // list directory
- `read({ path: "screenshot.png", workdir: "/tmp/agent-artifacts" })`
