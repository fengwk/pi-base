<p align="center">
  🌐 <a href="edit.md">English</a> · <a href="edit.zh-CN.md">简体中文</a>
</p>

# `edit`

[← Tool index](README.md) · [Shared architecture](../architecture.md)

## Purpose

Performs exact string replacement in an existing text file.

## Entry point

- Registration and core implementation: [`src/edit-core.ts`](../../src/edit-core.ts)
- Schema: [`src/schemas/edit.ts`](../../src/schemas/edit.ts)
- Prompt: [`prompts/edit.md`](../../prompts/edit.md)
- Line endings: [`src/line-endings.ts`](../../src/line-endings.ts)
- Encoding: [`src/text-codec.ts`](../../src/text-codec.ts)

## Parameters

| Parameter | Required | Default | Description |
|------|------|------|------|
| `path` | yes | — | Existing text file |
| `old_string` | yes | — | Exact text to replace |
| `new_string` | yes | — | Replacement text |
| `replace_all` | no | `false` | Replace all exact matches |
| `workdir` | no | session cwd | Base for relative path resolution |

## Execution chain

```text
validate parameters
  -> normalize old/new to LF
  -> resolve path
  -> file change queue
     -> stat + read
     -> decode text
     -> find exact match
     -> build replacement result
     -> preserve encoding/BOM/EOL
     -> write
  -> LSP sync observer
  -> numbered diff
```

## Matching semantics

- `old_string` must not be empty.
- `old_string` and `new_string` must differ.
- By default, `old_string` must be unique in the file.
- Fails when there is no match.
- Fails when there are multiple matches and `replace_all=false`.
- With `replace_all=true`, all non-overlapping matches are replaced; overlapping matches are rejected.

Only line endings are normalized to LF before matching; whitespace, indentation, and punctuation are not trimmed. The whitespace, indentation, punctuation, and line breaks in `old_string` must match the target file content exactly.

## Encoding and line endings

Existing files are read via `decodeTextFile`, preserving:

- Original encoding
- BOM
- Per-line line endings
- Whether a final newline exists

The replacement text is applied in an LF view and written back via `serializeLineEndingDocument`. For files with mixed line endings, the line endings of the replaced region are preferred for reuse.

Legacy encodings use round-trip validation on write-back; writing fails when the new text cannot be represented losslessly.

## Concurrency

The full read-match-write flow sits in the file change queue. Concurrent modifications to the same path are serialized; a later edit re-reads the file after the previous one commits.

## Diff

Successful results produce a numbered diff:

- Default 4 lines of context.
- Whether hunks are merged is decided by their distance.
- `details` includes the diff, first changed line, absolute path, and replacement count.

When the renderer streams parameters, it also builds a preview diff, but the preview does not participate in the real write.

## Permission and LSP

- Permission matches on `path`.
- The permission prompt does not include the full old/new bodies.
- After a successful write, `lspManager.syncFileIfOpen` is called.
- An observer failure does not turn an already-committed file modification into a tool failure.

## Error

The following cases return `isError: true`:

- Missing parameters.
- Target is not a regular file.
- Binary file.
- old/new are identical.
- Old string not found.
- Match is not unique.
- Replace-all matches overlap.
- Encoding cannot be written back losslessly.
- Output bytes are unchanged.

## Related tests

- [`tests/edit-write-index.test.ts`](../../tests/edit-write-index.test.ts)
- [`tests/edit-diff.test.ts`](../../tests/edit-diff.test.ts)
- [`tests/edit-queue.test.ts`](../../tests/edit-queue.test.ts)
- [`tests/line-endings.test.ts`](../../tests/line-endings.test.ts)
- [`tests/text-codec.test.ts`](../../tests/text-codec.test.ts)
- [`tests/permission.test.ts`](../../tests/permission.test.ts)
- [`tests/tool-renderers.test.ts`](../../tests/tool-renderers.test.ts)
