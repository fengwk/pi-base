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
| `column_offset` | no | `1` | 1-based Unicode code-point column where the first returned line starts; text reads only |

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
- A single line displays at most 2000 Unicode code points.
- Non-regular files and binary files are rejected.
- The display layer escapes carriage returns and NUL.
- `column_offset` applies only to the first returned line; a column past the end of that line is rejected, while column 1 stays valid for any line.
- When `column_offset` is greater than 1, the header gains a `column_offset:` line stating that the first displayed line starts mid-line, so it is not mistaken for a complete source line.
- Explicit `column_offset` values are rejected for directory and image reads.

The window stops at the first line whose fragment hits the per-line cap so later lines are never displayed before that line's remainder, and the whole result (header, body, and continuation notices) is kept inside the shared tool-output budget (50 KiB / 2000 physical lines) so downstream truncation never removes the cursor.

When the window stops before the end of the file, the result includes a continuation notice with the exact next position: `offset` for line-based continuation, plus `column_offset` when a line was cut mid-line.

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

If a line fragment is cut at the read layer, the window stops at that line, the result writes `details.upstreamTextTruncated` plus `details.next` (`line` and `column`) so the [public result handling chain](../architecture.md#tool_result) knows the full text can no longer be recovered from the current result, and the continuation notice names the executable follow-up call (`offset` plus `column_offset`) that resumes from the exact next code point.

## Related tests

- [`tests/read.test.ts`](../../tests/read.test.ts)
- [`tests/read-window.test.ts`](../../tests/read-window.test.ts)
- [`tests/image-fallback.test.ts`](../../tests/image-fallback.test.ts)
- [`tests/text-codec.test.ts`](../../tests/text-codec.test.ts)
- [`tests/line-endings.test.ts`](../../tests/line-endings.test.ts)
- [`tests/special-file-tools.test.ts`](../../tests/special-file-tools.test.ts)
- [`tests/workdir.test.ts`](../../tests/workdir.test.ts)
