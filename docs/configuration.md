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

## Validation

Configuration must be a JSON object. Only the following top-level keys are allowed:

- `lsp`
- `permission`
- `render`
- `notify`
- `yolo`
- `mcp`
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
| `mcp.servers` | Merged by server key; same-key project entries override |
| `compactionModel` | Project value overrides |
| `compactionThinkingLevel` | Project value overrides |
| `contextCompression` | Scalars override item by item; arrays are replaced as a whole |
| `subagent` | Each field overrides item by item |
| `defaultAgent` | Project value overrides |

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

## `yolo`

Boolean, default `false`. When enabled, the permission guard is skipped.

`/yolo` only toggles the runtime state in the current process; it does not write back to the JSON.

## `mcp`

### Local servers

```json
{
  "mcp": {
    "startupTimeoutMs": 60000,
    "callTimeoutMs": 60000,
    "servers": {
      "local": {
        "type": "local",
        "command": ["my-mcp", "serve"],
        "cwd": "~/work/project",
        "env": {
          "API_KEY": "${API_KEY}"
        },
        "toolPrefix": "local"
      }
    }
  }
}
```

### Remote servers

```json
{
  "mcp": {
    "servers": {
      "docs": {
        "type": "remote",
        "transport": "streamable-http",
        "url": "https://example.com/mcp",
        "headers": {
          "Authorization": "${DOCS_TOKEN}"
        }
      }
    }
  }
}
```

Supported transports:

- `streamable-http`
- `sse`
- `websocket`

`env` and `headers` only allow whole-value references to `$VAR` or `${VAR}`; string interpolation is not supported. The WebSocket transport does not support custom headers.

`toolPrefix` defaults to the server key; an empty string keeps the remote tool's original name.

## `subagent`

```json
{
  "subagent": {
    "maxDepth": 2,
    "maxConcurrency": 10,
    "maxTotalConcurrency": 20,
    "idleTimeoutMs": 300000,
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
