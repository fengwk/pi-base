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
     -> detect encoding/BOM
     -> encode content
     -> mkdir parent
     -> writeFile
  -> LSP sync observer
  -> Created/Overwrote result
```

## New files

- The parent directory is created via recursive `mkdir`.
- The default encoding is UTF-8.
- A BOM is produced when `content` starts with a BOM marker.
- Line breaks in `content` are written as-is from the caller.

## Overwriting existing files

An existing target must be judged a regular file via `stat`. Before writing, the original bytes are read and the encoding is detected:

- Preserve the existing encoding.
- Preserve the existing BOM.
- The existing line-ending style is not automatically preserved; `content` is the final text of the complete file.

Fails when a legacy encoding cannot represent the new content.

`write` uses `stat` to determine the target type, so symlinks are judged as regular files by their target and followed by `writeFile`; see the shared safety boundary in [architecture](../architecture.md#paths-and-file-writes).

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
