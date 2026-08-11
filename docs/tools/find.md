<p align="center">
  🌐 <a href="find.md">English</a> · <a href="find.zh-CN.md">简体中文</a>
</p>

# `find`

[← Tool index](README.md) · [Shared architecture](../architecture.md)

## Purpose

Finds files and directories with `fd` by glob.

## Entry point

- Registration wrapper: [`src/index-impl.ts`](../../src/index-impl.ts) `registerFindTool`
- Execution: [`src/find-tool.ts`](../../src/find-tool.ts)
- Schema: [`src/schemas/find.ts`](../../src/schemas/find.ts)
- Prompt: [`prompts/find.md`](../../prompts/find.md)

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `pattern` | yes | — | Glob file pattern |
| `path` | yes | — | Search root directory |
| `workdir` | no | session cwd | Base for resolving relative paths |
| `limit` | no | `1000` | Maximum number of results |
| `timeout_seconds` | no | none | Optional timeout |

`path` has no implicit default. Searching the current directory requires passing `"."` explicitly.

## Execution chain

```text
Registration wrapper validates path
  -> Resolve workdir and absolute search root
  -> Optional timeout signal
  -> ensureTool("fd")
  -> Spawn fd
  -> Read stdout line by line
  -> Convert to paths relative to the search root
  -> Results/limit/partial error
```

## fd arguments

Fixed arguments:

```text
--glob
--color=never
--hidden
--no-require-git
--max-results <limit>
```

`--full-path` is used when the pattern contains `/`. Plain relative full-path patterns get a `**/` prefix so they can match at any depth below the search root.

When the system has no `fd`, the internal tool manager tries to download the official GitHub Release; `PI_OFFLINE=1` disables this.

## Path output

- Results are relative to `path`.
- Separators are always displayed as `/`.
- Trailing slashes on directories from fd output are preserved.
- File names are not `trim()`ed, so trailing spaces remain representable.

## Limit

When `limit` is reached, a hint is appended to the result and `details.resultLimitReached` is set.

fd's `--max-results` limits the process output; the local layer supplements metadata based on the actual result count.

## Timeout and abort

The tool core listens for an AbortSignal and terminates fd. The registration wrapper is responsible for converting the optional `timeout_seconds` into a timeout signal and distinguishing user cancellation from an internal timeout.

## Error and partial output

- fd unavailable or download failed: execution fails.
- Spawn failed: execution fails.
- Non-zero exit code: returns the exit code and stderr.
- On non-zero exit with stdout already containing content, the result keeps `Partial output` and sets `details.partialOutput`.
- No results return `No files found matching pattern`, which is not an error.

## Related tests

- [`tests/find-tool-native.test.ts`](../../tests/find-tool-native.test.ts)
- [`tests/search-tools.test.ts`](../../tests/search-tools.test.ts)
- [`tests/regressions.test.ts`](../../tests/regressions.test.ts)
- [`tests/workdir.test.ts`](../../tests/workdir.test.ts)
- [`tests/process-termination.test.ts`](../../tests/process-termination.test.ts)
- [`tests/tool-renderers.test.ts`](../../tests/tool-renderers.test.ts)
