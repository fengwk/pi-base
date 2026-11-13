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
  -> ensureTool("rg")
  -> Directory search: start the encoding-candidate pre-pass, then the main search (concurrent)
  -> Parse match events
  -> Decode candidate files; re-search declared ones on their decoded text
  -> Format paths/line numbers
  -> Handle limit, long lines, timeout, and the not-searched notice
```

## ripgrep arguments

Plain mode always uses:

```text
--no-config
--json
--line-number
--color=never
--hidden
```

Both plain and multiline searches ignore ripgrep configuration (`RIPGREP_CONFIG_PATH`), so ambient options cannot change the tool's regex, literal, case, or glob behavior. Use `bash` for searches that intentionally rely on a custom ripgrep configuration.

Additional flags per parameter:

- `--ignore-case`
- `--fixed-strings`
- `--glob`
- `--multiline`

When the system has no `rg`, the internal tool manager tries to download the official GitHub Release. `PI_OFFLINE=1`, `true`, or `yes` disables the download.

`include` globs are relative to the search path. Directory searches run ripgrep inside the search root (so globs follow the caller's path and symlinked directories resolve through the link), and a leading `./` in the glob is ignored because ripgrep never matches one. A pattern without `/` matches file names at any depth.

## Target prechecks

- Directories can be searched directly; binary filtering inside them is left to ripgrep.
- A single file must be regular and decodable text. Its decoded text is searched when it declares a non-UTF-8 encoding, and a binary or undecodable file returns an error with the `read` wording instead of a silent skip.

## Result format

Plain matches:

```text
src/example.ts:42: matching line
```

Directory searches use paths relative to the search root; single-file searches use the basename.

### Text encoding

Results must agree with `read`, so a directory search starts a second, concurrent `rg` process before the main search: `rg --files-with-matches --encoding utf-8` over the same filters with the pattern `coding[:=]|charset|<\?xml|pageEncoding|\x{FFFD}`. It lists the only files whose decoded text can differ from plain UTF-8: files with declaration-like text and files that are not valid UTF-8. Both scans run in parallel; the search waits for the pre-pass only when it formats the result.

Each candidate file is decoded with [`src/text-codec.ts`](../../src/text-codec.ts). A UTF-8 file keeps ripgrep's raw results. A file with a byte order mark or a declaration that selects another encoding is searched again by ripgrep reading its normalized decoded text from stdin, so the regex engine is the same and line numbers equal `read`'s. A file the codec rejects is skipped, and its matches are dropped.

A final notice names skipped files:

```text
[Not searched because the text encoding could not be determined: /abs/a.txt, /abs/b.txt, … and 3 more]
```

It lists at most ten absolute paths and a remaining count, appears with or without matches (after `No matches found` when nothing matched), and is absent when every candidate decoded.

Line excerpts use ripgrep's UTF-8 byte offsets on the reported text. If an event lacks line text, plain mode re-reads the file and decodes it once.

A line longer than the display budget is shown as an excerpt centered on the first ripgrep submatch of that line: the submatch's UTF-8 byte offsets are mapped back onto the reported text, so a match far into a long line stays visible with context on both sides. Excerpts hold at most 500 code points and mark trimmed content with `…`; they are cut on code-point boundaries, so multi-byte characters and surrogate pairs are never split. Multiline events excerpt each displayed line against the part of the match that covers it. If an event carries no submatch offsets, the line-start prefix fallback applies.

## Limit and truncation

- A single displayed line is at most 500 code points, plus an `…` marker where content was cut.
- `limit` counts match events. Reaching the limit alone is not truncation: the notice and `details.matchLimitReached` appear only when ripgrep reports at least one further match event, and that lookahead match is never displayed.
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
- Non-regular files, binary files, undecodable single files, invalid regexes, and download failures all return `isError: true`.

## Related tests

- [`tests/grep-native.test.ts`](../../tests/grep-native.test.ts)
- [`tests/grep-excerpts.test.ts`](../../tests/grep-excerpts.test.ts)
- [`tests/grep-multiline-behavior.test.ts`](../../tests/grep-multiline-behavior.test.ts)
- [`tests/grep-multiline-errors.test.ts`](../../tests/grep-multiline-errors.test.ts)
- [`tests/search-tools.test.ts`](../../tests/search-tools.test.ts)
- [`tests/regressions.test.ts`](../../tests/regressions.test.ts)
- [`tests/timeout.test.ts`](../../tests/timeout.test.ts)
