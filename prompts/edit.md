Edit an existing text file using fresh `LINE:HASH` anchors.

Usage:
- Use `edit` only with fresh anchors from `read`, `write`, or a prior successful `edit` result for the same region.
- After a successful edit, the result returns a diff for the changed region. Lines prefixed with `+` or `|` carry the current `LINE:HASH` anchors for follow-up edits in that region.
- If the anchor you need is stale or outside the returned diff, rerun `read` before retrying.
- If the context shows a pi-base context compression placeholder for prior file output, do not reuse anchors or file content from the omitted output; refresh with `read` first.
- Replacement text is plain file content and must not include `LINE:HASH` prefixes.
- `edit` has only two top-level parameters: `path` and `edits`.
- `edits` is an array of operations. Each item must contain exactly one operation: `replace_lines`, `delete_lines`, `insert_before`, or `insert_after`.
- `replace_lines`, `insert_before`, and `insert_after` all treat `new_text` as raw file content. Newline characters are preserved; include `\n` explicitly when you want to create line breaks. Use `delete_lines` when the intent is to remove whole lines.

Parameters:
- `path` (required)
- `edits` (required)

Examples:
- Replace one line (`start_anchor` = `end_anchor`):
  - `edit({ path: "src/example.ts", edits: [{ replace_lines: { start_anchor: "45:4bf", end_anchor: "45:4bf", new_text: "export function buildDemoDirectory(): UserDirectory {" } }] })`
- Replace an inclusive line range:
  - `edit({ path: "src/example.ts", edits: [{ replace_lines: { start_anchor: "45:4bf", end_anchor: "47:91a", new_text: "export function createDemoDirectory(): UserDirectory {\n  return { users: [] };\n}" } }] })`
- Delete one line (`start_anchor` = `end_anchor`):
  - `edit({ path: "src/example.ts", edits: [{ delete_lines: { start_anchor: "60:abc", end_anchor: "60:abc" } }] })`
- Delete an inclusive line range:
  - `edit({ path: "src/example.ts", edits: [{ delete_lines: { start_anchor: "60:abc", end_anchor: "61:def" } }] })`
- Insert new text before an anchored line:
  - `edit({ path: "src/example.ts", edits: [{ insert_before: { anchor: "20:abc", new_text: "const enabled = true;" } }] })`
- Insert new text after an anchored line:
  - `edit({ path: "src/example.ts", edits: [{ insert_after: { anchor: "20:abc", new_text: "const enabled = true;" } }] })`
