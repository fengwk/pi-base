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

> **Note**: MCP is no longer configured in `pi-base.json`. Pi native MCP uses `~/.pi/agent/mcp.json` or `.pi/mcp.json` with standard `mcpServers` format. See the [MCP Migration Guide](mcp-migration.md) for migrating existing configs.

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

Bash uses static command analysis; commands that cannot be conservatively analyzed and are not explicitly denied fall back to `ask`.

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

Desktop notifications are supported on Linux desktop and WSL. A tmux jump targets stable session, window, and pane IDs, compares the selected client’s current state in that order, and changes only the levels that differ. It stops on failure and verifies what the same client displays. Window and pane selections are shared by tmux, so other clients displaying the same session or a linked window can see those changes without being switched to another session.

### GNOME Wayland

Install and enable [Activate Window By Title](https://extensions.gnome.org/extension/5021/activate-window-by-title/) (`activate-window-by-title@lucaswerkmeister.de`) for your GNOME Shell version. The focus action needs `tmux`, `gdbus`, and `python3` with PyGObject (`python3-gi` on Ubuntu); Linux notifications also require `notify-send`. In the **host tmux** configuration set:

```tmux
set -g set-titles on
set -g set-titles-string '#S:#I:#W [pi-tmux:#{pid}:#{client_pid}]'
```

The terminal must preserve the `[pi-tmux:<server>:<client>]` suffix **at the end** of its GNOME window title. Click the notification body to jump. The D-Bus helper keeps the same connection open from sending the notification until the click, dismissal, or `PI_NOTIFY_ACTION_TIMEOUT_SEC` seconds (default `600`). This lets it receive clicks that GNOME directs back to the sender. Without PyGObject, notification action support, or a safe tmux target, Pi sends a plain notification instead.

When a notification is created, Pi records the source server, pane, session, and attached client candidates. It prefers clients viewing the source pane, then other clients in its session, breaking ties by numeric PID. A client from another session is eligible as a fallback only if exactly one was attached outside the source session at creation time. A client that changes sessions remains eligible; clients attached later or with a reused tty are not. The pane must belong to just one session and remain in that session, but it can move to another window there.

On click, the extension must match a candidate’s exact title suffix before tmux is changed. This skips SSH clients without a matching local window. After the jump, the script requests activation again; an extension match means it asked GNOME to activate the window, not that focus was observed. A stale target, missing window, or failed activation or jump reports the failing stage on stderr.

For an opt-in focus smoke test, run `python3 scripts/test-gnome-focus.py --run` from Alacritty. It opens temporary windows on an isolated tmux server and checks focus and pane selection. It does not test clicking a desktop notification.

To roll back, remove the two `set-titles` lines and **restore the previous `set-titles` and `set-titles-string` values in the running tmux server**. Reloading the configuration alone does not clear those settings. You can disable the extension and still receive plain notifications.

### WSL and other Linux desktops

WSL uses the Windows notification helper. Other Linux desktops use `notify-send` for the Jump action and do not require PyGObject. The jump resolves the original pane ID on its captured tmux server, even after renumbering or moving the pane. If the pane is linked to several sessions but is no longer in the captured session, it stops rather than guessing. It prefers the captured terminal, then a client in the target session. Otherwise it only falls back to a sole terminal client and refuses to guess between several. Older Windows notifications carrying `session:window.pane` still work if those names and indexes still match.

## `yolo`

Boolean, default `false`. When enabled, the permission guard is skipped.

`/yolo` only toggles the runtime state in the current process; it does not write back to the JSON.

## `mcp` (Native MCP)

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
`exposure: "direct"` is independent of `codemode` registration or activation.
Native discovery extensions and `defaultTools` are configured in Pi's
`settings.json`, not as new `pi-base.json` fields; see the
[Pi 1.0 settings example](tools/mcp.md#native-discovery-settings) to enable
`codemode` and disable tool search.
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

- `anchorHygiene: true`: after a file is later modified successfully, earlier successful `read` and `edit` results for the same path are replaced. Failed results and `write` acknowledgements are not replaced by this mechanism.
- `tools` with a non-empty array: age compression is applied to the listed tools. Only successful results that are both outside the retention window and match a listed tool name are replaced; `read` results for skill files are kept.

When neither is enabled, `contextCompression` has no effect. Compression only replaces the content of tool results sent to the model; it does not replace user messages, assistant messages, tool call arguments, or tool errors. When the model needs details from old results, it must re-read or re-run the tool, so tools with side effects or high cost should be added to `tools` with caution.

Enable it only in long sessions with dense tool calls that show clear context pressure. Keep it off for short sessions, tasks that still need full debug output, or commands that cannot be safely replayed.

```json
{
  "contextCompression": {
    "anchorHygiene": true,
    "tools": ["read", "grep", "find", "bash", "edit", "write"],
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

Custom compaction streams through the session's model registry, preserving request-time provider authentication and configured endpoints/headers. Resolved OAuth tokens are not replayed as explicit API keys. If the model is unavailable or the request fails, pi-base warns and falls back to Pi's current-model compaction.

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
