Create a text file or intentionally overwrite a whole text file.

Usage:
- Use `write` for new files or intentional whole-file replacement only.
- For existing files, prefer `edit`; use `write` only for whole-file replacement or roughly 60%+ file-wide rewrites, never for localized edits that an `edit` can handle safely.
- Provide complete content without placeholders such as `...` or omitted sections.
- Overwriting an existing file keeps its encoding and byte order mark. New content that declares an encoding may convert a file without a byte order mark, but removing a non-UTF-8 declaration is refused; declare the new encoding explicitly to convert.
- `write` returns a success message only. If you need to inspect the resulting file content, use `read` afterward.

Examples:
- `write({ path: "src/new-module.ts", content: "export const demo = 1;\n" })`
- `write({ path: "docs/new-template.md", workdir: "packages/web", content: "# New template\n\nComplete file content.\n" })`
- `write({ path: "generated/report.txt", workdir: "/tmp/agent-artifacts", content: "full generated report\n" })`
