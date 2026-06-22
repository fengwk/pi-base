Read a text file, directory, or supported image by path.

Usage:
- Use `read` before editing an existing text file.
- Text file output prefixes each displayed line with a `LINE#HASH|` anchor prefix, for example `1#7936|export const value = 1;`. Use only the `LINE#HASH` part as an edit anchor.
- Use `offset` and `limit` to read large files in chunks.
- Use `read` on directories instead of `bash ls`.

Parameters:
- `path` (required)
- `workdir` (optional, default: the agent's current working directory; if provided, resolve from that directory)
- `offset` (optional, default: 1)
- `limit` (optional, default: 200, max: 2000)

Examples use pseudo-code tool calls:
- `read({ path: "src/example.ts", workdir: "packages/web" })`
- `read({ path: "src/example.ts", workdir: "services/api", offset: 120, limit: 40 })`
- `read({ path: "src/" })`
- `read({ path: "screenshot.png", workdir: "/tmp/agent-artifacts" })`
