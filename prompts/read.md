Read a text file, directory, or supported image by path.

Usage:
- Use `read` before editing an existing text file.
- Text file output includes `LINE:HASH|content` anchors.
- Use `offset` and `limit` to read large files in chunks.
- Use `read` on directories instead of `bash ls`.

Parameters:
- `path` (required)
- `offset` (optional, default: 1)
- `limit` (optional, default: 200, max: 2000)

Examples:
- `read({ path: "src/example.ts" })`
- `read({ path: "src/example.ts", offset: 120, limit: 40 })`
- `read({ path: "src/" })`
- `read({ path: "screenshot.png" })`
