Create a text file or intentionally overwrite a whole text file.

Usage:
- Use `write` for new files or intentional whole-file replacement only.
- For existing files, prefer `edit` with the smallest safe ranges. Use `write` only when the file is being replaced as a whole, rewritten into a substantially different file, or changed/refactored at roughly 60%+ of its content.
- Provide complete content without placeholders such as `...` or omitted sections.
- After a successful write, the result includes the current file content with fresh `LINE#HASH` anchors. Use those anchors directly for follow-up `edit` calls on the same file.
- Use `edit` instead of `write` for local changes to an existing file.

Parameters:
- `path` (required)
- `workdir` (required)
- `content` (required)

Examples show the arguments passed to the tool:
- `{"path":"src/new-module.ts","workdir":"packages/web","content":"export const demo = 1;\n"}`
- `{"path":"src/config.ts","workdir":"services/api","content":"export const config = { enabled: true };\n"}`
- `{"path":"src/config.ts","workdir":".","content":"export const config = { enabled: false };\n"}`
