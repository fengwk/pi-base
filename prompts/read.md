Read a text file, directory, or supported image by path.

Usage:
- Use `read` before editing an existing text file.
- Text file output prefixes each displayed line with a `LINE#HASH|` anchor prefix, for example `1#7936|export const value = 1;`. Use only the `LINE#HASH` part as an edit anchor.
- Use `offset` and `limit` to read large files in chunks.
- Use `read` on directories instead of `bash ls`.

Parameters:
- `path` (required)
- `offset` (optional, default: 1)
- `limit` (optional, default: 200, max: 2000)

Examples show the arguments passed to the tool:
- `{"path":"src/example.ts"}`
- `{"path":"src/example.ts","offset":120,"limit":40}`
- `{"path":"src/"}`
- `{"path":"screenshot.png"}`
