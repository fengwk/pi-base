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

## Glob scope

- Without `/`, a glob matches names at any depth below `path`: `*.ts` searches recursively.
- A relative glob containing `/` matches paths **relative to `path`**. `src/*.ts` only matches direct entries in the root's `src`; `src/**/*.ts` also matches descendants of that `src`. Use `**/src/*.ts` for direct entries in `src` directories at any depth below the root.
- Leading `./` is removed before deciding how to match: `./*.ts` is still recursive. A bare `./` is not a glob; use it in `path` and provide a pattern.
- Absolute globs still match absolute paths within the requested search tree. A glob never expands the traversal beyond `path`.

**Migration:** Previously `src/*.ts` could also find `pkg/src/file.ts`. Use `**/src/*.ts` if that was intentional. A root named `src` is no longer considered part of the relative path; use `path: "src", pattern: "*.ts"` to search inside that root.

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

Normally `fd` uses `--glob --color=never --hidden --max-results <limit + 1>`. A path glob uses `--full-path`; for a relative glob the tool prepends the escaped search root. Smart case comes from the original glob, not from the added root.

On Windows, relative path globs are matched against `fd` output after relativizing each path, because older Windows `fd` versions do not reliably match full-path globs. `fd` still applies the same traversal and ignore rules.

Inside a Git repository (including worktrees), `find` uses fd's native Git-aware ignore handling so rules above the repository do not hide its files. Outside a repository, it adds `--no-require-git` so `.gitignore` remains effective. That option requires fd 8.7.0 or a compatible build: pi-base checks the available binaries and, if necessary, downloads a separate compatible fd without replacing the existing one. If none is available and the download is disabled or fails, `find` reports an error rather than silently ignoring `.gitignore`.

When the system has no `fd`, the internal tool manager tries to download the official GitHub Release; `PI_OFFLINE=1` disables all of these downloads.

## Path output

- Results are relative to `path`.
- Separators are always displayed as `/`.
- Trailing slashes on directories from fd output are preserved.
- File names are not `trim()`ed, so trailing spaces remain representable.

## Limit

`limit` is normalized before spawning `fd`: values below 1 (including `0`, which fd
treats as unlimited) are clamped to `1`, and positive decimals are rounded down.
Ordinary positive integers pass through unchanged.

The tool looks ahead by one matching entry to distinguish exactly `limit` matches from overflow.
Only real overflow appends the hint, sets `details.resultLimitReached`, and caps the output at `limit` entries.

fd's `--max-results` normally limits the process output. The Windows relative-path filter instead stops fd after the first additional matching path.

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
