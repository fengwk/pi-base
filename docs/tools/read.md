<p align="center">
  🌐 <a href="read.md">English</a> · <a href="read.zh-CN.md">简体中文</a>
</p>

# `read`

[← Tool index](README.md) · [Shared architecture](../architecture.md)

## Purpose

Reads text files, directories, and supported images, and returns a line-numbered view of text for positional reference.

## Entry point

- Registration: [`src/read-core.ts`](../../src/read-core.ts) `registerReadTool`
- Schema: [`src/schemas/read.ts`](../../src/schemas/read.ts)
- Prompt: [`prompts/read.md`](../../prompts/read.md)
- Image fallback: [`src/image-fallback.ts`](../../src/image-fallback.ts)

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `path` | yes | — | File, directory, or image path |
| `workdir` | no | session cwd | Base for resolving relative paths |
| `offset` | no | `1` | Starting text line, 1-based |
| `limit` | no | `200` | Maximum text lines, up to 2000 |

## Execution chain

```text
Validate parameters
  -> Resolve workdir/path
  -> stat
     -> directory: readdir + sort
     -> image: model capability check + image attachment/skill prompt
     -> regular file: size check + read + decode
  -> Build header and numbered lines
  -> Return result
```

## Reading text

The text branch re-runs `stat` and the read in the file-change queue to avoid interleaving with concurrent writes.

Decoding is done by [`src/text-codec.ts`](../../src/text-codec.ts), covering:

- UTF BOM
- UTF-16 heuristic without BOM
- Legacy encoding detection
- Binary detection

Text result format:

```text
path: ...
ends_with_newline: yes|no
lsp: supported|unsupported

1|first line
2|second line
```

The number column width is computed from the file's total line count. A trailing newline at the end of the file does not generate an extra numbered blank line.

## Limits

- `limit` is capped at 2000.
- Candidate text files over 64 MiB are rejected before a full read.
- A single line displays at most 2000 characters.
- Non-regular files and binary files are rejected.
- The display layer escapes carriage returns and NUL.

When the end of the read window is reached but the file still has content, the result includes a hint for the next `offset`.

## Directories

Directory entries are sorted by name, and directory names get a `/` suffix. Directory reads are not recursive.

## Images

Directly supported extensions:

- `.jpg`
- `.jpeg`
- `.png`
- `.gif`
- `.webp`
- `.bmp`

When the model supports images, the tool delegates to Pi's image read capability and keeps the attachment. When the model does not support images, it returns a text hint directing to read `skills/image-understanding/SKILL.md`.

## LSP integration

`read` creates an LSP resolver from the target file's directory and reports in the header:

- The current extension has no LSP configured.
- Configured and the server is available.
- Configured but the server is not installed.

It does not automatically open an LSP document because a file was read.

## Error and truncation

All exceptions are converted to `Error: ...` with `isError: true`.

If a single line is truncated at the read layer, the result writes `details.upstreamTextTruncated` so the [public result handling chain](../architecture.md#tool_result) knows the full text can no longer be recovered from the current result.

## Related tests

- [`tests/read.test.ts`](../../tests/read.test.ts)
- [`tests/image-fallback.test.ts`](../../tests/image-fallback.test.ts)
- [`tests/text-codec.test.ts`](../../tests/text-codec.test.ts)
- [`tests/line-endings.test.ts`](../../tests/line-endings.test.ts)
- [`tests/special-file-tools.test.ts`](../../tests/special-file-tools.test.ts)
- [`tests/workdir.test.ts`](../../tests/workdir.test.ts)
