# pi-base

`pi-base` is a minimal Pi extension that provides a stable local coding toolset built around hash-anchored text editing.

## Jump to

- [Quick start](#quick-start)
- [Included tools](#included-tools)
- [Configuration](#configuration)
- [Slash commands](#slash-commands)
- [Validation](#validation)

## Quick start

For most setups, you only need four things:

1. Put your global config in `~/.pi/agent/pi-base.json`.
2. Optionally add a project override in `<repo>/.pi/pi-base.json`.
3. After editing either file, run `/reload` in Pi.
4. Use the built-in file, shell, LSP, and MCP tools as needed.

Typical workflow:

1. Discover with `read`, `grep`, `find`, and `lsp_*`.
2. Modify files with `edit` or `write`.
3. Run commands with `bash` when you need tests, builds, git, or external CLIs.
4. Add MCP servers when you want extra tools such as search, scraping, or internal platform integrations.

If you just want to get started, create `~/.pi/agent/pi-base.json` with `{}` first, then add only the sections you actually need.

### What to use when

- Need to read a file or directory? Use `read`.
- Need to search text across files? Use `grep`.
- Need to locate files by name or glob? Use `find`.
- Need to make a small change to an existing file? Use `edit`.
- Need to create a new file or replace a whole file? Use `write`.
- Need to run tests, builds, git, or external CLIs? Use `bash`.
- Need IDE-style diagnostics or symbol navigation? Use `lsp_*`.
- Changed `pi-base.json` and want the running process to pick it up? Use `/reload`.
- Want to inspect MCP server/tool state? Use `/mcp-status`.

## Included tools

Built-in tools:

- `read` — read files, directories, and supported images; when the model has no image input, image reads return text-only guidance with the `image-understanding` skill name and `skillDoc` path (use `read` on that file for full instructions)
- `grep` — search file contents and return matching lines
- `find` — discover files by glob pattern
- `bash` — run commands such as tests, builds, git, or external CLIs
- `edit` — make small, anchor-based edits to existing files
- `write` — create a new text file or intentionally replace a whole file
- `lsp_diagnostics` — get diagnostics from a configured LSP server
- `lsp_goto_definition` — jump to a symbol definition
- `lsp_workspace_symbols` — search symbols across the workspace
- `lsp_java_decompile` — inspect external Java classes through `jdtls`

Dynamic tools:

- configured MCP tools — any tools exposed by enabled MCP servers in `pi-base.json`

## Quick examples

### Minimal `pi-base.json`

```json
{}
```

### Minimal MCP config

```json
{
  "mcp": {
    "servers": {
      "mm": {
        "type": "local",
        "command": ["my-mcp", "serve"],
        "toolPrefix": ""
      }
    }
  }
}
```

After editing config files, run `/reload` in Pi.

### Minimal project override

Create `<repo>/.pi/pi-base.json` when one repository needs different policy or integrations than your global defaults.

```json
{
  "permission": {
    "bash": "ask"
  }
}
```

## Core ideas

- Text reads prefix each displayed line with a `LINE#HASH|` anchor prefix, for example `1#7936|export const value = 1;`; use only the `LINE#HASH` part as an edit anchor.
- `edit` works from fresh anchors and fails clearly on stale anchors.
- `write` returns fresh anchors for follow-up edits.
- Context compression can be enabled to prune stale file outputs and bulky historical tool results; when `anchorHygiene` is enabled, obsolete `LINE#HASH` anchors from `read` / `write` / `edit` are replaced with concise placeholders before model calls.
- `grep` requires an explicit `path`, defaults `workdir` to the agent's current working directory, defaults to a 15s timeout, fails fast on single-file binary inputs, and returns candidate locations rather than edit anchors; use `read` after `grep` before editing.
- `find` is delegated to Pi's built-in implementation. `pi-base` still requires an explicit `path`, while `workdir` defaults to the agent's current working directory.
- `bash`, `read`, `edit`, `write`, `grep`, `find`, and `lsp_*` default `workdir` to the agent's current working directory. If `workdir` is provided, path resolution or command execution uses that directory; for `bash`, prefer `workdir` over embedding `cd ... &&` in `command`.
- On Linux, WSL, and macOS, `bash` prefers the host `bash` or `zsh` shell from `$SHELL` and loads common startup files to better match the terminal environment.
- `permission` rules can require approval for selected tools such as `edit`, `write`, and `bash`; `/yolo` temporarily bypasses those checks, and `/resume-all` opens a session picker across all known project directories.
- Tool output is wrapped by a global truncation layer (`MAX_LINES=2000`, `MAX_BYTES=50KB`); full output is saved under `os.tmpdir()/pi-base-truncation/` and re-exposed via `details.truncation`.
- When a tool result indicates a failure (text starts with `Error:` / `Edit failed` / `Command exited with code N`), the global `tool_result` hook repairs the missing `isError` flag so downstream code (session logs, renderers, orchestration) can react correctly.
- LSP servers are **fully user-defined** in the unified `pi-base` config under `lsp.servers`. `pi-base` ships no built-in server table.
- MCP servers are configured in the same unified `pi-base` config under `mcp.servers`. `pi-base` connects to them asynchronously, auto-registers their tools, shows `MCP: x/y servers` in the second footer line, and exposes `/mcp-status` for a tree view of server/tool state.
- `notify` can mirror OpenCode-style desktop notifications for permission prompts and completed agent turns. By default it uses `$HOME/.config/opencode/scripts/notify.sh` when that script exists, and otherwise stays silent.

If you only need daily usage, you can usually stop reading after this section. The rest of the document is reference material for specific config areas and behaviors.

## Configuration

`pi-base` uses a unified config file:

- Global: `~/.pi/agent/pi-base.json`
- Project: `<repo>/.pi/pi-base.json`

The same file contains LSP, permission, render preview config, MCP config, context compression config, and optional default YOLO mode.
A completely valid starting point is:

```json
{}
```

Then add only the sections you need, for example `permission`, `lsp`, `mcp`, `notify`, `render`, or `contextCompression`.

For isolated tests or temporary runs, `PI_BASE_GLOBAL_SETTINGS_PATH` can override the global `pi-base` config path.

Config is loaded into the current Pi process and cached by workspace. If you edit either config file while pi is running, run `/reload` for the latest `pi-base.json` values to replace the in-memory policy.

Precedence:

```text
project JSON > global JSON > built-in defaults
```

### Example: tool result preview lines

`render.collapsedToolResultLines` accepts either:

- a single non-negative integer, applied to every tool result, or
- an object keyed by exact tool name or `*` wildcard pattern, with optional `"*"` as the fallback default.

- `0` hides a collapsed result body entirely and shows only the expand hint.
- When omitted, `pi-base` keeps the existing per-tool defaults (`read=10`, `grep=15`, `find=20`, `bash=20`, others use their current renderer defaults).
- This only affects **tool result** folding, not tool call previews.
- Exact tool names win over wildcard patterns. When multiple wildcard patterns match, the most specific pattern wins.

```json
{
  "render": {
    "collapsedToolResultLines": {
      "*": 20,
      "read": 10,
      "grep": 15,
      "lsp_*": 5,
      "mcp_*": 8,
      "bash": 0
    }
  }
}
```
### Example: tool result preview max characters

`render.collapsedToolResultMaxChars` accepts either:

- a single non-negative integer, applied to every tool result, or
- an object keyed by exact tool name or `*` wildcard pattern, with optional `"*"` as the fallback default.

This limit only affects the **collapsed** result preview. Expanded tool results still render the full content. It is useful for very large single-line outputs or huge JSON payloads.
Wildcard precedence matches `collapsedToolResultLines`: exact tool names win first, then the most specific wildcard pattern, then `"*"`.

```json
{
  "render": {
    "collapsedToolResultMaxChars": {
      "*": 10000,
      "bash": 4000,
      "*_search": 2000,
      "web_search": 1200
    }
  }
}
```

### Example: context compression

`contextCompression` is the only context-pruning config. It is opt-in: when omitted, pi-base does not compress context.
It is a stateless projection over the current message list. It does not keep a runtime tracker, delete assistant tool calls, modify tool call arguments, or change tool result metadata; only selected successful `toolResult.content` is replaced.

`anchorHygiene` controls whether earlier file outputs from `read` / `write` / `edit` are omitted after the same file changes later. It defaults to `false`.

Age compression uses one shared retention policy for every tool name listed under `tools`. Configure `retainedUserMessageRounds` and `retainedAssistantTurns` once at `contextCompression`, then list the tool names to match. Tool names are matched directly against `toolCall.name`; tools not listed are not age-compressed. When the shared retention fields are omitted, pi-base defaults to `retainedUserMessageRounds: 2` and `retainedAssistantTurns: 4`. Future conversation is grouped into user-message windows: each window starts at a user message and ends at the next user message or the current end of the transcript. Whole windows are accumulated until they contribute at least `retainedAssistantTurns` assistant turns; that accumulated set counts as one retained user round. A tool result is age-compressed only after at least `retainedUserMessageRounds` such retained user rounds appear after it. Failed tool results are never compressed.

Skill reads are protected from `tools` age compression. pi-base detects reads under currently advertised skill locations and keeps those outputs unless anchor hygiene later proves the same file changed. No separate `readSkill` config key is needed.

```json
{
  "contextCompression": {
    "anchorHygiene": true,
    "retainedUserMessageRounds": 2,
    "retainedAssistantTurns": 4,
    "tools": [
      "bash",
      "custom_tool"
    ]
  }
}
```

Placeholders stay short and vary only by tool category:

```text
[context compression: older tool output omitted. Re-run the tool if you need those details.]
[context compression: older tool output omitted. If you need those details, re-check the current state or retrieve the relevant context again.]
[context compression: older tool output omitted. If you need those details, re-check the current state, or re-run the command only if it is safe to do so.]
```

Context compression does not add session-history messages or a persistent UI marker; the configured behavior is driven entirely by `pi-base.json`.

### Example: notifications

`notify` controls desktop notifications emitted by `pi-base` itself.

- When omitted, notifications stay disabled.
- Notifications are enabled per event: set `permissionAsked` and/or `agentEnd` to `true`.
- `pi-base` uses its bundled Pi notifier script from `scripts/notify.sh` automatically; no command path is required in config.
- `permissionAsked` controls approval-request notifications.
- `agentEnd` controls completion notifications emitted on `agent_end`.
- `suppressCompletedAfterRejectionMs` (default `2000`, set `0` to disable) is the time window after a permission is rejected during which a follow-up `agent_end` completion notification is suppressed. The window prevents the "Pi - Permission" toast from being followed immediately by a "Pi - Completed" toast for the same session, which would be noise. Lower it (or set to `0`) if you want every completion to surface.

```json
{
  "notify": {
    "permissionAsked": true,
    "agentEnd": true,
    "suppressCompletedAfterRejectionMs": 0
  }
}
```
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
- The prompt shows the tool name, explicit `Workdir: ...`, and a compact one-line `Arguments: ...` preview; long previews are truncated with `...`.
- The only choices are `Yes` or `No`.
- Future automatic allowance comes only from config pattern matches; there is no in-session "always allow this file/command" shortcut.
- For path-based tools (`read`, `edit`, `write`, and similar tools that expose `path`), patterns are matched against the given path, the workdir-relative path, the project-relative path, and the absolute path.
- For `bash`, patterns are matched against static surface command segments. The matcher is quote/escape-aware for top-level `&&`, `||`, `|`, `|&`, `;`, and newline separators, but it does not expand variables, read scripts, or recursively inspect runtime content inside `bash -c`, command substitutions, `eval`, `source`, functions, or aliases.
- In non-interactive mode, `ask` blocks the tool call because there is no UI to confirm it.
- `/yolo` toggles a runtime bypass mode that disables all permission checks for the current Pi process and workspace, and shows `YOLO` inline in the footer while it is active. It does not take subcommands; use `/yolo` again to switch back.

### Example: default YOLO mode

Set `yolo` to a boolean:

```json
{
  "yolo": true
}
```

When omitted, the default is `false`. When present, it seeds the in-memory YOLO mode when pi-base first loads the workspace settings. `/yolo` changes only the current Pi process state; it is not persisted into session history or written back to `pi-base.json`.

### Example: MCP servers

`mcp.servers` defines MCP connections by server key. `toolPrefix` defaults to the server key; set it to `""` to expose the raw MCP tool names.

Remote servers must declare their transport explicitly. Supported values are `"websocket"`, `"sse"`, and `"streamable-http"`.

```json
{
  "mcp": {
    "servers": {
      "mm": {
        "type": "local",
        "command": ["my-mcp", "serve"],
        "env": {
          "MINIMAX_API_HOST": "https://api.minimaxi.com",
          "MINIMAX_API_KEY": "${MINIMAX_API_KEY}"
        },
        "toolPrefix": "",
      },
      "docs": {
        "type": "remote",
        "transport": "streamable-http",
        "url": "https://example.com/mcp",
        "headers": {
          "Authorization": "Bearer <token>"
        },
        "toolPrefix": "docs"
      }
    }
  }
}
```

Behavior notes:

- MCP startup is asynchronous and does not block session startup.
- `toolPrefix: ""` keeps the original MCP tool names.
- When omitted, `toolPrefix` falls back to the server key, for example `mm_scrape`.
- `env` and `headers` values support exact `$VAR` and `${VAR}` environment variable references. Literal strings remain unchanged.
- Connection summary is shown in the second footer line as `MCP: connected/enabled servers`.
- `/mcp-status` prints the full server/tool tree, including reconnect state and name conflicts.
## Slash commands

- `/yolo`
  - Toggles permission bypass for the current Pi process and workspace.
- `/resume-all`
  - Opens a picker for sessions across all project directories known to Pi, unlike the built-in `/resume` flow that stays focused on the current project/session directory.
  - In TUI mode it opens directly in the all-project view with recent sorting.
  - Takes no arguments.
- `/mcp-status`
  - Prints the current MCP server summary and a tree of discovered tools, reconnect state, and any name conflicts.

### Example: LSP servers for a Java + Go + TS + Python workspace

`command[0]` is either a bare executable resolved from `PATH`, or an explicit executable path. Path-like entries must be absolute; `~/...`, `$HOME/...`, and `${HOME}/...` are expanded before launch.

```json
{
  "lsp": {
    "servers": {
      "jdtls": {
        "command": ["$HOME/.local/share/nvim/mason/bin/jdtls"],
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
| `command` | yes | Executable + args. `command[0]` must be either a command available on `PATH` or an absolute executable path; `~/...`, `$HOME/...`, and `${HOME}/...` are supported. |
| `extensions` | yes | File extensions this server handles, e.g. `[".ts", ".tsx"]`. |
| `rootMarkers` | no | Workspace root markers for multi-module projects (topmost wins). |
| `firstMatchMarkers` | no | Alternative workspace root markers (first match wins). |
| `requestTimeoutMs` | no | Per-request timeout. Defaults to `60000`. Increase further for very slow servers like `gopls` on large workspaces. |

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

`lsp_diagnostics` does not pre-check because servers like `jdtls` push diagnostics in practice even when their advertised capability is missing or uses a non-standard field. For most servers the client tries `textDocument/diagnostic` first and falls back to waiting for pushed diagnostics; for `jdtls` it skips the pull request, waits for `publishDiagnostics` directly, and serializes same-workspace cold-start diagnostics until the first publish result arrives to avoid startup races.

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
