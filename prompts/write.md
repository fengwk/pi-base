Create a text file or intentionally overwrite a whole text file.

Usage:
- Use `write` for new files or intentional whole-file replacement.
- Provide complete content without placeholders such as `...`.
- After a successful write, the result includes the current file content with fresh `LINE:HASH` anchors. Use those anchors directly for follow-up `edit` calls on the same file.
- Use `edit` instead of `write` for local changes to an existing file.

Parameters:
- `path` (required)
- `content` (required)

Examples:
- `write({ path: "src/new-module.ts", content: "export const demo = 1;\n" })`
- `write({ path: "src/config.ts", content: "export const config = { enabled: true };\n" })`
- `write({ path: "src/config.ts", content: "export const config = { enabled: false };\n" })`
