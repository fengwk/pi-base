<p align="center">
  🌐 <a href="write.md">English</a> · <a href="write.zh-CN.md">简体中文</a>
</p>

# `write`

[← Tool index](README.md) · [Shared architecture](../architecture.md)

## Purpose

Creates a new file, or overwrites an existing file with complete content.

## Entry point

- Registration: [`src/write-register.ts`](../../src/write-register.ts)
- Execution: [`src/write-core.ts`](../../src/write-core.ts)
- Schema: [`src/schemas/write.ts`](../../src/schemas/write.ts)
- Prompt: [`prompts/write.md`](../../prompts/write.md)

## Parameters

| Parameter | Required | Default | Description |
|------|------|------|------|
| `path` | yes | — | File to create or fully overwrite |
| `content` | yes | — | Complete file content |
| `workdir` | no | session cwd | Base for relative path resolution |

## Execution chain

```text
validate parameters
  -> resolve path
  -> file change queue
     -> stat/read existing target
     -> decode text and reject binary or undecodable files
     -> resolve output encoding/BOM
     -> encode content
     -> mkdir parent
     -> atomic write (temp file + rename)
  -> LSP sync observer
  -> Created/Overwrote result
```

## New files

- The parent directory is created via recursive `mkdir`.
- A standard declaration in `content` selects the encoding (XML, CSS, HTML, Python/Ruby cookie, JSP); otherwise the default is UTF-8. Decoding rules are shared with [read](read.md#reading-text).
- A BOM is produced when `content` starts with U+FEFF and the encoding has one.
- Line breaks in `content` are written as-is from the caller.

## Overwriting existing files

An existing target must be judged a regular file via `stat`. Before writing, the original bytes are decoded as text with the deterministic codec:

- Reject binary or undecodable files without modifying them.
- A BOM stays authoritative: the existing encoding and BOM are kept, and a declaration in `content` must select that same encoding.
- Without a BOM, a declaration in `content` selects the new encoding and may convert the file. Dropping a non-UTF-8 declaration is refused: `The new content removes the {name} declaration of {path}.`
- Text the output encoding cannot represent fails with the character, its code point and the line.
- The existing line-ending style is not automatically preserved; `content` is the final text of the complete file.

`write` uses `stat` to determine the target type, so symlinks are judged as regular files by their target and followed by `writeFile`; see the shared safety boundary in [architecture](../architecture.md#paths-and-file-writes). The commit itself writes a temporary file in the target directory, applies the original mode, fsyncs, and renames it over the target, keeping a symlink and replacing the file it resolves to.

## Concurrency and abort

The existing-file check, encoding selection, parent-directory creation, and write all live in the file change queue.

The AbortSignal is checked before the write starts. Once a write has started, the underlying operation is awaited to completion, because filesystem writes cannot be reliably rolled back; an abort after completion does not hide modifications that already happened.

## Permission and LSP

- Permission matches on the target path.
- The permission prompt does not include the full `content`.
- On success, open LSP documents are synced.
- An LSP observer failure does not override the actual file result.

## Rendering

Write calls have a dedicated content preview:

- Streaming parameters use a 10-line scrolling window.
- Under settled/YOLO, the first 7 content lines and the remaining line count are shown by default.
- The full call content can be viewed after expansion.

The result body contains only `Created ...` or `Overwrote ...`.

## Error

- Missing `path` or `content`.
- Target exists but is not a regular file.
- Target exists but is a binary file or its encoding cannot be determined.
- The new content conflicts with the existing encoding.
- Read or encoding failure.
- Parent-directory creation failure.
- File write failure.

All errors are converted to `Error: ...` with `isError: true`.

## Related tests

- [`tests/write-behavior.test.ts`](../../tests/write-behavior.test.ts)
- [`tests/edit-write-index.test.ts`](../../tests/edit-write-index.test.ts)
- [`tests/workdir.test.ts`](../../tests/workdir.test.ts)
- [`tests/special-file-tools.test.ts`](../../tests/special-file-tools.test.ts)
- [`tests/permission.test.ts`](../../tests/permission.test.ts)
- [`tests/tool-renderers.test.ts`](../../tests/tool-renderers.test.ts)
