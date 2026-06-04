# pi-base

`pi-base` is a minimal Pi extension that provides a stable local coding toolset built around hash-anchored text editing.

## Included tools

- `read`
- `grep`
- `find`
- `bash`
- `edit`
- `write`
- `lsp_diagnostics`
- `lsp_goto_definition`
- `lsp_workspace_symbols`
- `lsp_java_decompile`

## Core ideas

- Text reads return `LINE:HASH|content` anchors.
- `edit` works from fresh anchors and fails clearly on stale anchors.
- `write` returns fresh anchors for follow-up edits.
- Context compression can be enabled to prune stale file outputs and bulky historical tool results; when `anchorHygiene` is enabled, obsolete `LINE:HASH` anchors from `read` / `write` / `edit` are replaced with concise placeholders before model calls.
- `grep` requires an explicit `path`, defaults to a 15s timeout, fails fast on single-file binary inputs, and returns candidate locations rather than edit anchors; use `read` after `grep` before editing.
- `find` is delegated to Pi's built-in implementation, but `pi-base` makes `path` explicit and required — there is no implicit search root.
- `bash` requires an explicit `workdir` on every call.
- On Linux, WSL, and macOS, `bash` prefers the host `bash` or `zsh` shell from `$SHELL` and loads common startup files to better match the terminal environment.
- `permission` rules can require approval for selected tools such as `edit`, `write`, and `bash`; `/yolo` temporarily bypasses those checks, and `/resume-all` opens a session picker across all known project directories.
- Tool output is wrapped by a global truncation layer (`MAX_LINES=2000`, `MAX_BYTES=50KB`); full output is saved under `os.tmpdir()/pi-base-truncation/` and re-exposed via `details.truncation`.
- When a tool result indicates a failure (text starts with `Error:` / `Edit failed` / `Command exited with code N`), the global `tool_result` hook repairs the missing `isError` flag so downstream code (session logs, renderers, orchestration) can react correctly.
- LSP servers are **fully user-defined** in the unified `pi-base` config under `lsp.servers`. `pi-base` ships no built-in server table.

## Configuration

`pi-base` uses a unified config file:

- Global: `~/.pi/agent/pi-base.json`
- Project: `<repo>/.pi/pi-base.json`

The same file contains LSP, permission, render preview config, context compression config, and optional default YOLO mode.

For isolated tests or temporary runs, `PI_BASE_GLOBAL_SETTINGS_PATH` can override the global `pi-base` config path.

Precedence:

```text
project JSON > global JSON > built-in defaults
```

### Example: tool result preview lines

`render.collapsedToolResultLines` accepts either:

- a single non-negative integer, applied to every tool result, or
- an object keyed by tool name, with optional `"*"` as the fallback default.

- `0` hides a collapsed result body entirely and shows only the expand hint.
- When omitted, `pi-base` keeps the existing per-tool defaults (`read=10`, `grep=15`, `find=20`, `bash=20`, others use their current renderer defaults).
- This only affects **tool result** folding, not tool call previews.

```json
{
  "render": {
    "collapsedToolResultLines": {
      "*": 20,
      "read": 10,
      "grep": 15,
      "write": 10,
      "bash": 0
    }
  }
}
```

### Example: context compression

`contextCompression` is the only context-pruning config. It is opt-in: when omitted, pi-base does not compress context.
It is a stateless projection over the current message list. It does not keep a runtime tracker, delete assistant tool calls, modify tool call arguments, or change tool result metadata; only selected `toolResult.content` is replaced.

`anchorHygiene` controls whether earlier file outputs from `read` / `write` / `edit` are omitted after the same file changes later. It defaults to `false`.

Age compression is configured per tool name under `tools`. Tool names are matched directly against `toolCall.name`; tools not listed are not age-compressed. A listed tool defaults to `retainedUserMessageRounds: 2` and `retainedAssistantTurns: 4` unless overridden. Consecutive user messages count as one user-message round.

Skill reads are protected from `tools.read` age compression. pi-base detects reads under currently advertised skill locations and keeps those outputs unless anchor hygiene later proves the same file changed. No separate `readSkill` config key is needed.

```json
{
  "contextCompression": {
    "anchorHygiene": true,
    "tools": {
      "bash": {
        "enable": true,
        "retainedUserMessageRounds": 2,
        "retainedAssistantTurns": 4
      },
      "custom_tool": {
        "enable": true
      }
    }
  }
}
```

Placeholders are intentionally short and unambiguous:

```text
[pi-base context compression: earlier file output omitted because the file changed later. Re-run read for current content before using LINE:HASH anchors.]
[pi-base context compression: older tool output omitted. Re-run the tool if you need those details.]
```

Context compression does not add session-history messages or a persistent UI marker; the configured behavior is driven entirely by `pi-base.json`.

### Example: permission guard

`permission` follows an OpenCode-style `allow` / `ask` / `deny` model. Put it in the unified `pi-base` config file (`~/.pi/agent/pi-base.json` or `.pi/pi-base.json`). Top-level strings apply to all tools, and per-tool objects can override them with ordered wildcard rules (`*` and `?`, last match wins).

```json
{
  "permission": {
    "edit": "ask",
    "write": "ask",
    "bash": {
      "*": "ask",
      "git *": "allow"
    }
  }
}
```

Behavior notes:

- `ask` prompts in interactive mode before the tool runs.
- The prompt is intentionally minimal: only `Yes` or `No`.
- Future automatic allowance comes only from config pattern matches; there is no in-session "always allow this file/command" shortcut.
- For path-based tools (`read`, `edit`, `write`, and similar tools that expose `path`), patterns are matched against the given path, the cwd-relative path, the project-relative path, and the absolute path.
- For `bash`, patterns are matched against the full command string.
- In non-interactive mode, `ask` blocks the tool call because there is no UI to confirm it.
- `/yolo` toggles a bypass mode that disables all permission checks for the current session and shows `YOLO` inline in the footer while it is active. It does not take subcommands; use `/yolo` again to switch back.

### Example: default YOLO mode

Set `yolo` to a boolean:

```json
{
  "yolo": true
}
```

When omitted, the default is `false`. When present, it seeds the default `/yolo` state for sessions that do not already have a persisted YOLO toggle entry. A session that already persisted a prior `/yolo` toggle keeps its stored state.

## Slash commands

- `/yolo`
  - Toggles permission bypass for the current session.
- `/resume-all`
  - Opens a picker for sessions across all project directories known to Pi, unlike the built-in `/resume` flow that stays focused on the current project/session directory.
  - In TUI mode it opens directly in the all-project view with recent sorting.
  - Takes no arguments.

### Example: LSP servers for a Java + Go + TS + Python workspace

`lsp.searchPaths` and path-like `command[0]` entries support `~/...`, `$HOME/...`, and `${HOME}/...` in addition to absolute or project-relative paths.

```json
{
  "lsp": {
    "searchPaths": [
      "~/.local/share/nvim/mason/bin"
    ],

    "servers": {
      "jdtls": {
        "command": ["jdtls"],
        "extensions": [".java"],
        "rootMarkers": ["pom.xml", "build.gradle", "settings.gradle"],
        "firstMatchMarkers": [".git"]
      },
      "typescript-language-server": {
        "command": ["typescript-language-server", "--stdio"],
        "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
        "firstMatchMarkers": [".git", "package.json", "tsconfig.json", "jsconfig.json"]
      },
      "gopls": {
        "command": ["gopls"],
        "extensions": [".go"],
        "firstMatchMarkers": [".git", "go.mod", "go.work"],
        "requestTimeoutMs": 60000
      },
      "pylsp": {
        "command": ["pylsp"],
        "extensions": [".py", ".pyi"],
        "firstMatchMarkers": [".git", "pyproject.toml", "setup.py", "requirements.txt", "Pipfile"]
      }
    }
  }
}
```

### LSP server entry fields

| Field | Required | Description |
|---|---|---|
| `command` | yes | Executable + args. The first element is searched in `PATH` then `lsp.searchPaths`. |
| `extensions` | yes | File extensions this server handles, e.g. `[".ts", ".tsx"]`. |
| `rootMarkers` | no | Workspace root markers for multi-module projects (topmost wins). |
| `firstMatchMarkers` | no | Alternative workspace root markers (first match wins). |
| `requestTimeoutMs` | no | Per-request timeout. Defaults to `15000`. Increase for slow servers like `gopls`. |

To "disable" a server, omit it from the map. There is no `disabledServers` list.

For server-specific runtime tuning, put the extra flags directly in `command`. Example for `jdtls` on a host JDK that supports ZGC:

```json
{
  "lsp": {
    "servers": {
      "jdtls": {
        "command": [
          "jdtls",
          "--jvm-arg=-XX:+UseZGC",
          "--jvm-arg=-XX:+ZUncommit"
        ],
        "extensions": [".java"]
      }
    }
  }
}
```

`pi-base` intentionally does not add a separate `jvmArgs` field; `command` is the single source of truth.

When a tool is called and the file extension is not in any `lsp.servers` entry, the tool returns a clear "No LSP server configured for ..." error.

### Capability pre-check

For `lsp_workspace_symbols` and `lsp_goto_definition`, the LSP client inspects the server's `initialize` response and short-circuits with a clear, actionable error before sending the request when the server did not advertise support. `lsp_java_decompile` is additionally gated on running `jdtls`. Examples:

- `pylsp` does not implement `workspace/symbol` → "LSP server 'pylsp' does not advertise workspace/symbol support. Try grep, find, or read with offset/limit instead."
- `pylsp` does not implement `go-to-definition` → "LSP server 'pylsp' does not advertise go-to-definition. Try grep or read to locate definitions manually."
- `lsp_java_decompile` on a non-jdtls server → "lsp_java_decompile is only supported by jdtls; current server is 'X'."

`lsp_diagnostics` does not pre-check because servers like `jdtls` push diagnostics in practice even when their advertised capability is missing or uses a non-standard field; the configured `requestTimeoutMs` will surface the unsupported or stalled case instead.

## Output truncation

Tool results that exceed `MAX_LINES=2000` or `MAX_BYTES=50KB` are truncated. The full output is persisted to `os.tmpdir()/pi-base-truncation/`, and `details.truncation` on the tool result includes:

| Field | Meaning |
|---|---|
| `truncated` | `true` if the output was reduced. |
| `alreadyTruncated` | `true` if an upstream layer (e.g. built-in bash) already truncated and saved the full output. |
| `outputPath` | Path to the full output (from upstream or from `pi-base`). |
| `totalLines` | Line count of the original (or upstream-truncated) output. |
| `totalBytes` | Byte count of the original output. |

When an upstream tool already truncated (e.g. Pi's built-in bash writes to `/tmp/pi-bash-*.log`), `pi-base` does not duplicate the full output but does preserve the upstream path in `details.truncation.outputPath`.

## Validation

```bash
npm run typecheck
npm test
npm run test:coverage
```

## Non-interactive `pi -p` note

When invoking `pi -p` from a shell, quote the prompt or pass it through a heredoc / file. Otherwise shell features such as `$(...)`, backticks, `$VAR`, and globs may expand before Pi sees the prompt text.

## Coverage status

Coverage is intentionally kept high, but the exact numbers change as tests evolve. Check the latest `npm test` / `npm run test:coverage` output for current counts.

See `DESIGN.md` for the full v1 design and protocol details.
