Read a text file, directory, or supported image by path.

Usage:
- Use `read` before editing an existing text file.
- For text files, the result is emitted in hashline mode:
  - header: `[path#TAG]`
  - numbered body lines: `LINE:TEXT`
- Use the exact `[path#TAG]` header from the latest `read`, `write`, or successful `edit` result when authoring a hashline patch.
- Use `offset` and `limit` to read large files in chunks. Only the lines that were actually displayed are authorized for follow-up `SWAP` / `DEL` / `INS.PRE` / `INS.POST` anchors under that tag.
- File size does not disable `[path#TAG]`. Large files still get a tag bound to the full file; only the lines shown in this read are authorized for the next `edit` under that tag. Use `offset` / `limit` to read other regions before editing there.
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
