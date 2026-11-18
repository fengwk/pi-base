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
| `edits` | yes | — | Non-empty array of independent replacements in this file |
| `edits[].old_string` | yes | — | Exact text to replace in the original file |
| `edits[].new_string` | yes | — | Replacement text; may be empty for deletion |
| `edits[].replace_all` | no | `false` | Replace all exact matches for this entry |
| `workdir` | no | session cwd | Base for relative path resolution |

## Execution chain

```text
validate parameters
  -> normalize old/new to LF
  -> resolve path
  -> file change queue
     -> stat + read
     -> decode text
     -> locate all matches in one pass
     -> build replacement result
     -> preserve encoding/BOM/EOL
     -> in-place write to the same path
  -> LSP sync observer
  -> numbered diff from the changed ranges
```

## Matching semantics

- `old_string` must not be empty.
- `old_string` and `new_string` may be identical, including after LF normalization. Unchanged entries still undergo all match and overlap checks.
- The complete batch must change the file's decoded content; an unchanged result fails without writing.
- By default, `old_string` must be unique in the file.
- Fails when there is no match.
- Fails when there are multiple matches and `replace_all=false`.
- With `replace_all=true`, all non-overlapping matches are replaced; overlapping matches are rejected.

Only line endings are normalized to LF before matching; whitespace, indentation, and punctuation are not trimmed. The whitespace, indentation, punctuation, and line breaks in `old_string` must match the target file content exactly.

## One input format

Always pass a non-empty `edits` array: one entry for one change, multiple entries for independent changes in the same file. Top-level `old_string`, `new_string`, and `replace_all` are not accepted:

```ts
edit({ path: "a.ts", edits: [
  { old_string: "const alpha = 1;", new_string: "const alpha = 2;" },
  { old_string: "const beta = 3;", new_string: "const beta = 4;" },
] });
```

Every entry is matched against the same original file snapshot, not the output of the preceding entry. All matches must be non-overlapping, including matches expanded by an entry's `replace_all`. Missing, ambiguous, overlapping, invalid, or unencodable replacements fail before any write. A successful batch writes once, reports the total number of matched occurrences (including unchanged entries), and returns one combined diff for the actual changes. A single edit writes once, but separate tool calls are not one transaction. Replacements that depend on earlier edits need separate calls, waiting for the earlier call to return before issuing the next.

## Encoding and line endings

Existing files are read via `decodeTextFile` with the shared replacement-decoder rules of [read](read.md#reading-text), so `read` and `edit` operate on the same decoded text. `edit` preserves:

- Original encoding
- BOM
- Per-line line endings
- Whether a final newline exists

The replacement text is applied in an LF view over the original snapshot and written back via `serializeLineEndingDocument`. Untouched lines keep their own endings; a mixed-ending file reuses the endings of the replaced region. A U+FFFD (�) produced by replacement decoding can be matched and replaced like any other character.

Every match is located in one pass over the original text, the spans are sorted once, and the output is built in one pass from slices, so `replace_all` stays linear in the file size. The numbered diff is built from the changed line ranges with context instead of diffing the whole file.

An edit never converts the file: a BOM stays authoritative, the declaration in the result must select the original encoding, and an undeclared UTF-8 file stays UTF-8. A change that would switch encodings is rejected with `This change would change the encoding of …`; use a complete-file `write` to convert. Text the resulting file's encoding cannot represent fails with the character, its code point and the line; when the character is U+FFFD, the error explains that it marks bytes that could not be decoded. Because the whole file is re-encoded, an edit can also replace other invalid byte sequences with U+FFFD (�) and can rewrite valid bytes that have several encodings for the same character into the canonical form (for example Shift_JIS `ED40` becomes `FA5C`, both 纊); reading before editing informs the change but does not preserve those original bytes.

After all matches, overlap checks, and encoding validation pass, the queued operation writes the output bytes directly to the target path. Symlinks are followed and the resolved file keeps its inode, so hard links, owner/group, and ordinary file permissions follow normal in-place semantics. Validation failures do not write. In-place writes are not crash-atomic: a crash or full disk during the write can leave partial content.

No extra tool arguments or confirmation steps are required.

## Concurrency

The full read-match-write flow sits in the process-local file change queue. Concurrent modifications to the same file are serialized; a later edit re-reads and matches the file after the previous operation completes, rejecting stale old text instead of blindly overwriting it. Separate calls are not one transaction: a later failure does not roll back earlier successful calls or automatically cancel other independent calls. The queue is not a cross-process lock.

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
- Invalid JSON arguments. When Pi provides a parse error, the tool preserves it instead of reporting missing fields; no file is edited.
- Target is not a regular file.
- Binary file.
- Old string not found.
- Match is not unique.
- Replace-all matches overlap.
- The result would change the file's encoding.
- The resulting text cannot be encoded in the file's encoding.
- The complete result leaves the decoded content or output bytes unchanged.

## Related tests

- [`tests/edit-write-index.test.ts`](../../tests/edit-write-index.test.ts)
- [`tests/edit-diff.test.ts`](../../tests/edit-diff.test.ts)
- [`tests/edit-queue.test.ts`](../../tests/edit-queue.test.ts)
- [`tests/edit-batch.test.ts`](../../tests/edit-batch.test.ts)
- [`tests/line-endings.test.ts`](../../tests/line-endings.test.ts)
- [`tests/text-codec.test.ts`](../../tests/text-codec.test.ts)
- [`tests/permission.test.ts`](../../tests/permission.test.ts)
- [`tests/tool-renderers.test.ts`](../../tests/tool-renderers.test.ts)
