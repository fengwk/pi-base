<p align="center">
  🌐 <a href="grep.md">English</a> · <a href="grep.zh-CN.md">简体中文</a>
</p>

# `grep`

[← Tool index](README.md) · [Shared architecture](../architecture.md)

## Purpose

Searches file contents with ripgrep, supporting plain, literal, case-insensitive, and multiline matching.

## Entry point

- Registration: [`src/grep-register.ts`](../../src/grep-register.ts)
- Execution: [`src/grep-core.ts`](../../src/grep-core.ts)
- Schema: [`src/schemas/grep.ts`](../../src/schemas/grep.ts)
- Prompt: [`prompts/grep.md`](../../prompts/grep.md)

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `pattern` | yes | — | Regex or literal text |
| `path` | yes | — | File or directory |
| `workdir` | no | session cwd | Base for resolving relative paths |
| `include` | no | — | File glob |
| `ignore_case` | no | `false` | Ignore case |
| `literal` | no | `false` | Fixed-string search |
| `multiline` | no | `false` | Allow matches across lines |
| `limit` | no | `100` | Maximum number of match events |
| `timeout_seconds` | no | `15` | Search timeout |

## Execution chain

```text
Validate pattern/path
  -> Resolve workdir/path
  -> stat target
  -> Single-file binary precheck
  -> ensureTool("rg")
  -> Spawn ripgrep --json
  -> Parse match events
  -> Format paths/line numbers
  -> Handle limit, long lines, and timeout
```

## ripgrep arguments

Plain mode always uses:

```text
--json
--line-number
--color=never
--hidden
```

Additional flags per parameter:

- `--ignore-case`
- `--fixed-strings`
- `--glob`
- `--multiline`

When the system has no `rg`, the internal tool manager tries to download the official GitHub Release. `PI_OFFLINE=1`, `true`, or `yes` disables the download.

## Target prechecks

- Directories can be searched directly.
- A single file must be a regular file.
- Single-file searches first read up to 1 MiB for binary detection.
- Binary filtering inside directories is left to ripgrep.

## Result format

Plain matches:

```text
src/example.ts:42: matching line
```

Directory searches use paths relative to the search root; single-file searches use the basename.

The base64 `bytes` field in ripgrep JSON is text-decoded. If an event lacks line text, plain mode re-reads the file by line number.

## Limit and truncation

- A single displayed line is at most 500 characters.
- When `limit` is reached, ripgrep is terminated and `details.matchLimitReached` is set.
- In multiline mode, `limit` counts match events; one event may display multiple lines.
- Long-line truncation sets `details.linesTruncated`.

These semantic truncations are marked via metadata so the [public result handling chain](../architecture.md#tool_result) can recognize them.

## Timeout and termination

`timeout_seconds` uses a separate AbortSignal. The dedicated timeout signal returns `Search timed out`; a parent abort returns the abort.

The child process tree is terminated via [`src/process-termination.ts`](../../src/process-termination.ts).

## Error

- ripgrep exit code `0`: there are matches.
- Exit code `1`: no matches, returns `No matches found`.
- Other exit codes: returns the stderr error.
- Non-regular files, binary files, invalid regexes, and download failures all return `isError: true`.

## Related tests

- [`tests/grep-native.test.ts`](../../tests/grep-native.test.ts)
- [`tests/grep-multiline-behavior.test.ts`](../../tests/grep-multiline-behavior.test.ts)
- [`tests/grep-multiline-errors.test.ts`](../../tests/grep-multiline-errors.test.ts)
- [`tests/search-tools.test.ts`](../../tests/search-tools.test.ts)
- [`tests/regressions.test.ts`](../../tests/regressions.test.ts)
- [`tests/timeout.test.ts`](../../tests/timeout.test.ts)
