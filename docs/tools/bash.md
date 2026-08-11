<p align="center">
  🌐 <a href="bash.md">English</a> · <a href="bash.zh-CN.md">简体中文</a>
</p>

# `bash`

[← Tool index](README.md) · [Shared architecture](../architecture.md)

## Purpose

Runs shell commands in a specified working directory and streams stdout/stderr.

## Entry point

- Registration: [`src/bash-renderer-register.ts`](../../src/bash-renderer-register.ts)
- Child process adaptation: [`src/bash-operations.ts`](../../src/bash-operations.ts)
- Call/result rendering: [`src/bash-renderer-core.ts`](../../src/bash-renderer-core.ts)
- Schema: [`src/schemas/bash.ts`](../../src/schemas/bash.ts)
- Prompt: [`prompts/bash.md`](../../prompts/bash.md)

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `command` | yes | — | Shell command |
| `workdir` | no | session cwd | Directory in which the command runs |
| `timeout_seconds` | no | `120` | Timeout in seconds |

## Execution chain

```text
Resolve workdir
  -> Get cwd-scoped Bash tool
  -> Map timeout_seconds to upstream timeout
  -> getShellConfig
  -> Spawn shell
  -> stdout/stderr -> onData
  -> exit / timeout / abort
  -> Bash renderer
```

The registration layer reuses the Bash tool contract of `@earendil-works/pi-coding-agent` but injects the local `createGracefulBashOperations` to unify process-tree termination and inherited stdio handling.

## Shell selection

The shell configuration is determined by Pi's `getShellConfig`.

On Linux/macOS, when `$SHELL` is Bash or Zsh, the renderer builds host shell options and loads the following startup files:

- Bash: `.bash_profile`, `.bash_login`, `.profile`, `.bashrc`
- Zsh: `.zshenv`, `.zprofile`, `.zshrc`

Windows uses the platform default shell configuration.

How the command is passed is determined by the shell configuration returned by `getShellConfig`, which may use argv or stdin transport; the local operations support both.

## Child processes

- Non-Windows uses a detached process group.
- Both stdout and stderr go into the same `onData` stream.
- Both abort and timeout terminate the process tree.
- Timeout first triggers terminate, which can be escalated to a forced kill by the common terminator.
- After the child exits, the timer, AbortSignal listener, and stdio handles are cleaned up.

The implementation relies on [`src/process-termination.ts`](../../src/process-termination.ts) and the internal `waitForChildProcess` helper.

## Permission

Bash does not match by path; it first goes through [`src/bash-command-analyzer.ts`](../../src/bash-command-analyzer.ts).

The analyzer splits the command on the following top-level separators:

- `&&`
- `||`
- `|`
- `|&`
- `&`
- `;`
- Newlines

The analyzer recognizes quotes, redirections, and heredocs. `command`, `env`, `exec`, `nohup`, `eval`, `source`, `.`, `sh`, `bash`, `dash`, `zsh`, `ksh`, `ksh93`, `mksh`, and `fish` are marked as dynamic wrappers.

Dynamic command heads, command substitution, process substitution, control flow, or shell constructs that cannot be conservatively analyzed are not treated as safely parsed; without an explicit deny, they fall back to `ask`. See the [architecture notes](../architecture.md#paths-and-file-writes) for the public Permission boundaries.

## Result and rendering

The Bash renderer:

- The streaming status shows elapsed time.
- The completed status shows total duration.
- Collapsed successful results keep trailing output first.
- Errors keep a limited amount of diagnostics even when configured for zero lines.
- When the upstream result already contains `fullOutputPath` or a truncation footer, the renderer does not add similar information again.

## Error

- Spawn errors are converted to `Error: ...`.
- Timeout uses the `timeout:<seconds>` marker inside the operations and is converted into a user result by the upstream Bash tool.
- Abort uses the `aborted` marker.
- Non-zero command exits are returned by the upstream Bash tool with the exit code and output.

## Related tests

- [`tests/bash-index.test.ts`](../../tests/bash-index.test.ts)
- [`tests/bash-operations.test.ts`](../../tests/bash-operations.test.ts)
- [`tests/bash-renderer-behavior.test.ts`](../../tests/bash-renderer-behavior.test.ts)
- [`tests/bash-command-analyzer.test.ts`](../../tests/bash-command-analyzer.test.ts)
- [`tests/permission.test.ts`](../../tests/permission.test.ts)
- [`tests/process-termination.test.ts`](../../tests/process-termination.test.ts)
