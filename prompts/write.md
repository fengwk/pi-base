Create a text file or intentionally overwrite a whole text file.

Usage:
- Use `write` for new files or intentional whole-file replacement only.
- For existing files, prefer `edit`; use `write` only for whole-file replacement or roughly 70%+ file-wide rewrites, never for localized edits that small `edit` operations can handle.
- Provide complete content without placeholders such as `...` or omitted sections.
- After a successful write, the result includes the current file content with fresh `LINE#HASH` anchors.

Parameters:
- `path` (required)
- `workdir` (optional, default: current working directory; if provided, resolve from that directory)
- `content` (required)

Examples use pseudo-code tool calls:
- `write({ path: "src/new-module.ts", content: "export const demo = 1;\n" })`
- `write({ path: "docs/new-template.md", workdir: "packages/web", content: "# New template\n\nComplete file content.\n" })`
- `write({ path: "generated/report.txt", workdir: "/tmp/agent-artifacts", content: "full generated report\n" })`
