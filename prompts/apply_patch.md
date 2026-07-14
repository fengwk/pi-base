Apply file changes with the OpenCode/Codex patch protocol.

Usage:
- Send one complete patch in `patchText`, beginning with `*** Begin Patch` and ending with `*** End Patch`.
- Supported operations are Add, Update, and Delete. `*** Move to:` is recognized for protocol compatibility but Move is not supported and the whole patch will fail before mutation.
- All file paths are resolved from the agent's current working directory. Prefer relative paths.
- Read existing files before updating them. Update chunks must match the current file; stale, missing, ambiguous, binary, or unrepresentable edits fail.
- Every file is preflighted before the first mutation. After preflight, files commit sequentially in patch order. A later race or filesystem failure can therefore leave earlier files committed; such errors report the files already applied and mark the failed path state as unknown.
- Add is create-only and fails if the target exists. Delete requires an existing regular text file. Update preserves supported encoding, BOM, and line-ending structure.
- Use concise context around each Update. Context lines begin with a space, removed lines with `-`, and added lines with `+`.
- `@@` may be followed by a function or section context line used to locate the chunk. `*** End of File` anchors the preceding chunk at EOF.
- Put the protocol text directly in `patchText`; do not add Markdown fences or a second JSON object inside the string. A shell-style heredoc wrapper is accepted, but the direct protocol is preferred.

Protocol:
```text
*** Begin Patch
*** Add File: path/to/new.txt
+first line
+second line
*** Update File: path/to/existing.txt
@@ optional function or section context
 context line
-old line
+new line
*** End of File
*** Delete File: path/to/obsolete.txt
*** End Patch
```

Rules:
- Add bodies contain only `+`-prefixed lines. An empty body creates an empty file.
- Delete has no body.
- Update contains one or more `@@` chunks, and each chunk must add or remove at least one line.
- File targets must be unique after path resolution.
- A patch with any parse or preflight error is non-mutating.

Parameters:
- `patchText` (required): complete patch protocol text.
