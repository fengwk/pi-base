<p align="center">
  🌐 <a href="configuration.md">English</a> · <a href="configuration.zh-CN.md">简体中文</a>
</p>

# Configuration Reference

See [`examples/pi-base.json`](../examples/pi-base.json) for a complete example.

## Configuration files

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/pi-base.json` |
| Project | Nearest `<repo>/.pi/pi-base.json` found by searching upward from cwd |

The `PI_BASE_GLOBAL_SETTINGS_PATH` environment variable overrides the global configuration path.

Configuration is cached in-process per cwd. Run `/reload` after modifying it.

Project `pi-base.json` is treated as trusted runtime configuration and is not gated by Pi's project-trust state. It can define executable LSP commands, so use project configuration only in repositories you trust. (MCP servers are configured separately in `.pi/mcp.json` or `~/.pi/agent/mcp.json` under Pi's native project-trust model).

## Validation

Configuration must be a JSON object. Only the following top-level keys are allowed:

- `lsp`
- `permission`
- `render`
- `notify`
- `yolo`
- `compactionModel`
- `compactionThinkingLevel`
- `contextCompression`
- `subagent`
- `defaultAgent`

Unknown fields produce an error and are not silently ignored.

## Merge rules

Project configuration and global configuration are merged field by field:

| Field | Rule |
|-------|------|
| `lsp.servers` | When the project declares `servers`, the global server map is replaced entirely |
| `permission` | Rule arrays are merged per tool, with project rules appended after global rules |
| `render` | Defaults and per-tool mappings are merged |
| `notify` | Shallow merge; project fields override global fields |
| `yolo` | Project value overrides |
| `compactionModel` | Project value overrides |
| `compactionThinkingLevel` | Project value overrides |
| `contextCompression` | Scalars override item by item; arrays are replaced as a whole |
| `subagent` | Each field overrides item by item |
| `defaultAgent` | Project value overrides |

> **Note**: MCP is no longer configured in `pi-base.json`. Pi 0.99.1 native MCP uses `~/.pi/agent/mcp.json` or `.pi/mcp.json` with standard `mcpServers` format. See the [MCP Migration Guide](mcp-migration.md) for migrating existing configs.

## `lsp`

```json
{
  "lsp": {
    "servers": {
      "typescript": {
        "command": ["typescript-language-server", "--stdio"],
        "extensions": [".ts", ".tsx", ".js", ".jsx"],
        "firstMatchMarkers": [".git", "package.json", "tsconfig.json"],
        "requestTimeoutMs": 60000
      }
    }
  }
}
```

Server fields:

| Field | Required | Description |
|-------|----------|-------------|
| `command` | Yes | Executable and arguments; the first item must be on PATH or an absolute path |
| `extensions` | Yes | File extensions the server handles |
| `rootMarkers` | No | Root markers for multi-module projects; the topmost match wins |
| `firstMatchMarkers` | No | The first match wins when searching upward |
| `requestTimeoutMs` | No | Per-request timeout, default 60000 |
| `workspaceData` | No | jdtls workspace data configuration |

`workspaceData`:

```json
{
  "mode": "stable",
  "baseDir": "/absolute/path/to/jdtls-workspaces"
}
```

- `stable`: uses a stable hash directory for the same project.
- `process`: the directory name additionally includes the PID.
- `disabled`: does not automatically add `-data`.

Command paths support `~/`, `$HOME/`, and `${HOME}/`. Other environment variables are not interpolated.

## `permission`

Supports `allow`, `ask`, and `deny`.

```json
{
  "permission": {
    "*": "allow",
    "edit": "ask",
    "write": "ask",
    "apply_patch": {
      "vendor/**": "deny",
      "*": "ask"
    },
    "bash": {
      "*": "ask",
      "git status*": "allow"
    }
  }
}
```

Rules can be strings or `pattern -> action` objects. Rules override in order; the last match wins.

Path tools consider all of:

- The raw path.
- The path relative to the workdir.
- The path relative to the project root.
- The absolute path.

`apply_patch` resolves all source and target paths and inherits the edit/write rules. Bash uses static command analysis; commands that cannot be conservatively analyzed and are not explicitly denied fall back to `ask`.

Permission guards against accidental operations; it is not a security sandbox.

## `render`

```json
{
  "render": {
    "collapsedToolResultLines": {
      "*": 20,
      "read": 10,
      "grep": 15,
      "lsp_*": 5
    },
    "collapsedToolResultMaxChars": {
      "*": 10000,
      "bash": 4000
    }
  }
}
```

- Numeric values represent the global default.
- Objects support exact tool names, wildcards, and `*`.
- Match priority: exact name > wildcard > `*`.
- Setting a line count to 0 hides successful content; errors keep a limited diagnostic preview.

## `notify`

```json
{
  "notify": {
    "permissionAsked": true,
    "agentEnd": true,
    "suppressCompletedAfterRejectionMs": 5000
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `permissionAsked` | `false` | Notify before a permission prompt |
| `agentEnd` | `false` | Notify when an agent run settles as completed or a non-retryable error; active Goal continuations do not send completed notifications |
| `suppressCompletedAfterRejectionMs` | `5000` | Suppress completed notifications after a permission rejection |

Desktop notifications are supported on Linux desktop and WSL; notifications are not enabled on other platforms.

To focus a tmux terminal on GNOME Wayland, install and enable the upstream [Activate Window By Title](https://extensions.gnome.org/extension/5021/activate-window-by-title/) extension (UUID `activate-window-by-title@lucaswerkmeister.de`). Check compatibility with your GNOME Shell release (upstream v15 declares Shell 45–51; consult the extension page for current support). `gdbus`, `notify-send`, and `tmux` must be available. In the **host tmux** configuration set:

```tmux
set -g set-titles on
set -g set-titles-string '#S:#I:#W [pi-tmux:#{pid}:#{client_pid}]'
```

The terminal must preserve this tmux title **at the end** of its GNOME window title. The source is tracked by the stable `TMUX_PANE` ID, which must resolve to exactly one session (a pane linked into several sessions is rejected). When the notification is created, the script records the tmux server PID, the source session, and a frozen, ordered list of attached clients: first the client currently viewing that pane, then clients of the source session, then any other client of the same server, with numeric PID ascending breaking ties. Nothing is activated or switched at that point.

On click the script revalidates the tmux server and the source pane/session, then walks the frozen candidates in order. Only candidates that still exist with the same tty and PID are considered; clients attached after the notification was created are never used, and deleted ones are skipped to the next captured candidate. The server and source are revalidated before every candidate, so a candidate that vanished is skipped, while a changed server/source aborts the click instead of activating anything against it. For each candidate the exact `[pi-tmux:<server>:<client>]` title is looked up through the extension, and a `(true,)` reply means a local window carries that exact title — a requested activation, **not** observed focus. An SSH client shares the tmux server but has no matching local window: it answers `(false,)` and is skipped without changing that session. Only after a match does the script re-check the source and the chosen client, switch exactly that client, select the captured session/window/pane by stable IDs, and request activation of that window once more (again revalidating server, source, and client). Because tmux sessions share their window and pane selection, switching the chosen client can change what other clients attached to the same session display, even though no `switch-client` is ever issued for them. Each failure stage reports its own concise error on stderr — stale server/source/client, no matching local window, D-Bus/extension error (including the underlying gdbus message), or a failed tmux switch/select — instead of reporting every error as a title miss. A D-Bus/extension error aborts immediately rather than retrying the remaining candidates; a title that lags is retried in up to three bounded passes, and several matching local windows resolve to the first by priority and numeric PID.

A focus action is offered whenever the server has at least one attached client, including an SSH-only server, because no local window can be enumerated before the click: the extension exposes activation only and `org.gnome.Shell.Introspect.GetWindows` replies `AccessDenied`, so there is no read-only preflight. Such an action may therefore fail with the error above. Non-tmux GNOME and servers without attached clients get a plain notification. `(true,)` confirms the extension matched a title and invoked activation, **not** observed focus. There is no generic class, X11 or BEL attention fallback.

For an opt-in desktop smoke test, run `python3 scripts/test-gnome-focus.py --run` from Alacritty. It opens three temporary windows on an isolated tmux server, with two of them sharing one session to exercise candidate priority and numeric-PID selection, verifies actual terminal focus reports and source-pane selection, then closes those windows. It does not test physical notification clicks or control monitor placement; test those separately with the target terminal fully visible on the other display.

To roll back, remove these lines from the host tmux configuration **and explicitly restore the saved previous `set-titles` and `set-titles-string` values in the running tmux server** (for example, via `tmux set -g`); merely reloading a configuration without these lines does not clear runtime options. Optionally disable the extension. Plain notifications remain available. WSL and X11 retain their existing jump paths.

## `yolo`

Boolean, default `false`. When enabled, the permission guard is skipped.

`/yolo` only toggles the runtime state in the current process; it does not write back to the JSON.

## `mcp` (Native MCP in Pi 0.99.1)

MCP is configured separately in `~/.pi/agent/mcp.json`, or `.pi/mcp.json` for a
trusted project. Project entries replace same-name global entries. It is not a
`pi-base.json` field. Use explicit `direct` exposure:

```json
{
  "mcpServers": {
    "local-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "exposure": "direct"
    },
    "remote-server": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${DOCS_TOKEN}"
      },
      "timeout": 60,
      "exposure": "direct"
    }
  }
}
```

`command` and `args` configure stdio; `url` configures streamable HTTP.
`timeout` is in seconds. Keep literal credentials out of checked-in files.
See [Native MCP tools](tools/mcp.md) for Agent policy and session behavior, and
the [migration guide](mcp-migration.md) for the one-time CLI and safety rules.

## `subagent`

```json
{
  "subagent": {
    "maxDepth": 2,
    "maxConcurrency": 10,
    "maxTotalConcurrency": 20,
    "idleTimeoutMs": 300000,
    "modelMaxRetries": 2,
    "maxTurns": 50
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `maxDepth` | `2` | Root depth is 1; `task` is not injected once the limit is reached |
| `maxConcurrency` | `10` | Concurrency limit for children of a single parent session |
| `maxTotalConcurrency` | Not enabled | Concurrency limit for the whole delegation tree |
| `idleTimeoutMs` | Not enabled | Timeout when there is no session activity |
| `modelMaxRetries` | Inherit Pi `retry.maxRetries` | Automatic model-call retries for each delegated session; `0` disables them |
| `maxTurns` | `50` | Default soft-stop turn budget |

## `contextCompression`

Off by default. When `contextCompression` is not configured, no historical tool results are replaced. Before a provider request, the feature projects the messages and replaces the content of qualifying old `toolResult`s with short placeholder text, reducing the historical tool output sent to the model; it does not generate conversation summaries and does not enlarge the model's context window.

There are two independent ways to enable it:

- `anchorHygiene: true`: after a file is later modified successfully, earlier successful `read`, `edit`, and `apply_patch` results for the same path are replaced. Failed results and `write` acknowledgements are not replaced by this mechanism.
- `tools` with a non-empty array: age compression is applied to the listed tools. Only successful results that are both outside the retention window and match a listed tool name are replaced; `read` results for skill files are kept.

When neither is enabled, `contextCompression` has no effect. Compression only replaces the content of tool results sent to the model; it does not replace user messages, assistant messages, tool call arguments, or tool errors. When the model needs details from old results, it must re-read or re-run the tool, so tools with side effects or high cost should be added to `tools` with caution.

Enable it only in long sessions with dense tool calls that show clear context pressure. Keep it off for short sessions, tasks that still need full debug output, or commands that cannot be safely replayed.

```json
{
  "contextCompression": {
    "anchorHygiene": true,
    "tools": ["read", "grep", "find", "bash", "edit", "write", "apply_patch"],
    "retainedUserMessageRounds": 2,
    "retainedAssistantTurns": 4,
    "enabledProviders": ["openai"],
    "disabledProviders": ["xai"]
  }
}
```

- `anchorHygiene`: enables stale file context cleanup; default `false`.
- `tools`: tool names allowed to undergo age compression; age compression is off when missing or an empty array.
- `retainedUserMessageRounds` / `retainedAssistantTurns`: together define the age threshold at which results enter the age compression scope; defaults are `2` and `4` respectively once age compression is enabled.
- `enabledProviders`: takes effect only for the listed providers; an empty array disables it for all.
- `disabledProviders`: explicitly excludes providers; it cannot be an empty array.

## `compactionModel`

```json
{
  "compactionModel": "google/gemini-2.5-flash",
  "compactionThinkingLevel": "high"
}
```

`compactionModel` must use the `provider/model` format.

Allowed thinking level values:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`
- `max`

## `defaultAgent`

```json
{
  "defaultAgent": "reviewer"
}
```

Agent selection priority at session startup:

```text
Agent persisted in the current session
  > --agent
  > defaultAgent
  > built-in default
```

The first item exists only in sessions that restored or inherited agent state; fresh sessions start evaluating from `--agent`.
