<p align="center">
  🌐 <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

# Configuration Examples

This directory provides a ready-to-copy `pi-base.json` and a set of Markdown Agents. `pi-base.json` only contains configuration that does not depend on local executables, service addresses, secrets, or notification platforms.

## Copy to the global configuration directory

On Linux, macOS, or WSL, run from the repository root:

```bash
mkdir -p ~/.pi/agent/agents
cp examples/pi-base.json ~/.pi/agent/pi-base.json
cp examples/agents/*.md ~/.pi/agent/agents/
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME/.pi/agent/agents"
Copy-Item examples/pi-base.json "$HOME/.pi/agent/pi-base.json"
Copy-Item examples/agents/*.md "$HOME/.pi/agent/agents/"
```

These files together form a ready-to-load global configuration. If a file with the same name already exists at the destination, back it up before copying. If Pi is already running, run `/reload` after copying.

| Example file | Destination |
|----------|----------|
| [`pi-base.json`](pi-base.json) | `~/.pi/agent/pi-base.json` or the project's `.pi/pi-base.json` |
| [`agents/*.md`](agents/) | `~/.pi/agent/agents/` |

## Included configuration

| Field | Example value | Behavior |
|------|--------|------|
| `defaultAgent` | `jiji` | Selects `jiji` when a new session has no persisted Agent and none is specified via `--agent` |
| `permission` | Reads and searches are allowed; file modifications ask; Bash asks by default | Git status, diff, log, and show commands are allowed directly; other Bash commands go through permission confirmation |
| `render` | 10 lines by default, 20 for Bash, up to 4000 characters | Controls the visible range of collapsed tool results |
| `subagent.maxDepth` | `3` | The root session depth is 1 and the maximum delegation depth is 3 |
| `subagent.maxConcurrency` | `4` | Each parent runs at most 4 direct children concurrently |
| `subagent.maxTotalConcurrency` | `8` | At most 8 Subagents run concurrently in the same root delegation tree |
| `subagent.idleTimeoutMs` | `120000` | Terminates a Subagent after 120 seconds without session activity |
| `subagent.maxTurns` | `50` | Uses a 50-turn soft-stop budget when a `task` call does not specify `maxTurns` |

## Agent models

The example Agents use the following models:

| Agent | Model | Thinking level |
|-------|-------|----------------|
| `jiji` | `openai/gpt-5.6-sol` | `max` |
| `coder` | `deepseek/deepseek-v4-flash` | `max` |
| `explorer` | `deepseek/deepseek-v4-flash` | `high` |
| `helper` | `deepseek/deepseek-v4-flash` | `high` |

When the model exists and authentication is configured, the Agent switches to the model and thinking level in the table; otherwise it keeps the current session model and issues a warning. You can replace `model` and `thinkingLevel` in the frontmatter of each Agent file.

## Configuration to add as needed

The following fields are not included in the ready-to-copy [`pi-base.json`](pi-base.json):

| Field | When to add |
|------|----------|
| `lsp` | The corresponding LSP server is installed, and the executable path, file extensions, and root markers are confirmed |
| `notify` | The environment is a Linux desktop or WSL, and permission or run-completion notifications are needed |
| `mcp` | The local server command or remote server URL, and the required environment variables, are determined |
| `contextCompression` | A long session with dense tool calls has created clear context pressure, and replacing old tool output with placeholder text is acceptable |
| `compactionModel` / `compactionThinkingLevel` | A provider and model are configured for context compaction |
| `yolo` | Explicitly need to skip the Permission guard; this configuration disables operation confirmation |

### LSP

`pi-base` does not bundle a built-in LSP server table. `lsp.servers.<name>.command[0]` must be a command on `PATH` or an absolute executable path. If the command does not exist, the configuration file still loads, but LSP calls for the corresponding files return a server-not-installed error.

The following template covers Java, TypeScript/JavaScript, Go, and Python. Keep only the servers installed in your current environment, and adjust the root markers to match your project structure:

```json
{
  "lsp": {
    "servers": {
      "jdtls": {
        "command": ["jdtls"],
        "extensions": [".java"],
        "rootMarkers": [
          "pom.xml",
          "build.gradle",
          "build.gradle.kts",
          "settings.gradle",
          "settings.gradle.kts"
        ],
        "firstMatchMarkers": [".git"],
        "requestTimeoutMs": 120000
      },
      "typescript-language-server": {
        "command": ["typescript-language-server", "--stdio"],
        "extensions": [
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
          ".mjs",
          ".cjs",
          ".mts",
          ".cts"
        ],
        "firstMatchMarkers": [
          ".git",
          "package.json",
          "tsconfig.json",
          "jsconfig.json"
        ],
        "requestTimeoutMs": 90000
      },
      "gopls": {
        "command": ["gopls"],
        "extensions": [".go"],
        "firstMatchMarkers": [".git", "go.mod", "go.work"],
        "requestTimeoutMs": 90000
      },
      "pylsp": {
        "command": ["pylsp"],
        "extensions": [".py", ".pyi"],
        "firstMatchMarkers": [
          ".git",
          "pyproject.toml",
          "setup.py",
          "requirements.txt",
          "Pipfile"
        ],
        "requestTimeoutMs": 90000
      }
    }
  }
}
```

See the [Configuration Reference](../docs/configuration.md#lsp) for LSP fields, workspace root, and JDTLS workspace data configuration.

### Notify

On a Linux desktop or WSL, you can add:

```json
{
  "notify": {
    "permissionAsked": true,
    "agentEnd": true,
    "suppressCompletedAfterRejectionMs": 5000
  }
}
```

Desktop notifications are not enabled on other platforms.

### MCP

A local MCP server requires `type: "local"`, `command`, and optionally `cwd`, `env`, and `toolPrefix`. A remote MCP server requires `type: "remote"`, `transport`, and `url`. Credentials reference environment variables with full values `$VAR` or `${VAR}`; interpolation inside strings is not supported, and credentials should not be written directly into the configuration file.

See the [MCP Configuration Reference](../docs/configuration.md#mcp) for local and remote examples.

### Context compression

Context compression is disabled by default and is not included in [`pi-base.json`](pi-base.json). Before sending context to the model, it replaces the bodies of eligible old `toolResult`s with short placeholder text, reducing the historical tool output in requests; it is not a conversation summary and does not expand the model's context window.

Two independent mechanisms are supported:

- `anchorHygiene: true`: after a file is subsequently modified successfully, replaces earlier successful `read`, `edit`, and `apply_patch` results for the same path.
- A non-empty `tools`: applies age compression to the listed tools. `retainedUserMessageRounds` and `retainedAssistantTurns` together define the age threshold at which results enter compression scope, with default values of `2` and `4` respectively.

Tool errors, user messages, assistant messages, and tool call arguments are never replaced. Once enabled, the model must re-read files or re-run tools when it needs details from old output; re-running commands with side effects such as Bash may be unsafe. Therefore, enable it only in long sessions with heavy tool output that have already shown context pressure.

Optional configuration:

```json
{
  "contextCompression": {
    "anchorHygiene": true,
    "tools": ["read", "grep", "find", "bash", "edit", "write", "apply_patch"],
    "retainedUserMessageRounds": 2,
    "retainedAssistantTurns": 4,
    "enabledProviders": ["openai"]
  }
}
```

When you only need to clean up stale file context, set just `anchorHygiene: true`; add `tools` when you need to compress tool output by age. See the [Context compression Configuration Reference](../docs/configuration.md#contextcompression) for provider filtering and field semantics.

### Compaction model

Add this when a separate compaction model is needed:

```json
{
  "compactionModel": "provider/model",
  "compactionThinkingLevel": "high"
}
```

`provider/model` must exist in Pi's model configuration.

See the [Configuration Reference](../docs/configuration.md) for the complete fields, default values, and merge rules, and [Markdown Agent](../docs/agents.md) for Agent frontmatter fields.
