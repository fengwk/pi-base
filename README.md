<p align="center">
  🌐 <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

# pi-base

`pi-base` is a plugin package for [Pi](https://github.com/earendil-works/pi) that provides file read/write, code search, command execution, LSP, MCP, Agent, Subagent, and Goal capabilities. This toolset has been validated in real-world internet development production environments.

> **Less is More.** Pursue a simple, stable set of tools.

More and more people inject large numbers of rules and tools into agents, believing it makes them smarter. In practice, the opposite is true. Agents are already smart; over-constraining a smart person makes them lazy, and the same applies to agents. We should let agents understand what and why, provide only a few tools that help them discover how, instead of stacking how, how, how...

## Built-in tools

`pi-base` provides the following built-in tools.

| Tool | Purpose |
|------|------|
| `read` | Read text, directories, and supported images |
| `grep` | Search for content in files or directories |
| `find` | Find files and directories by glob |
| `bash` | Run builds, tests, Git, and other commands |
| `edit` | Precisely replace existing text |
| `write` | Create new files or rewrite entire files |
| `apply_patch` | Structurally add, update, delete, or move multiple files |
| `lsp_goto_definition` | Look up symbol definitions |
| `lsp_workspace_symbols` | Search workspace symbols |
| `lsp_java_decompile` | Decompile external Java classes in the JDTLS workspace |
| `task` | Create or resume Subagent sessions |
| `create_goal` | Create a persistent Goal |
| `get_goal` | Read Goal status |
| `update_goal` | Mark a Goal as complete or blocked |

When no file modification tool is specified in an Agent's `tools`, models whose ID contains `gpt-` but not `gpt-4` or `oss` use `apply_patch`, and other models use `edit` and `write`; explicit configuration does not expand permissions: when `apply_patch` is configured alongside `edit` / `write`, only `apply_patch` is enabled, and models whose ID contains `gpt-` but not `gpt-4` or `oss` also use `apply_patch` when both `edit` and `write` are configured.

See the [tool documentation](docs/tools/README.md) for parameters and usage boundaries.

## Installation

Requires [Pi](https://github.com/earendil-works/pi) to be installed.

```bash
pi install git:github.com/fengwk/pi-base
```

Install into the current project:

```bash
pi install git:github.com/fengwk/pi-base -l
```

## Optional configuration

The configuration file supports two scopes: global and project.

| Scope | Path |
|--------|------|
| Global | `~/.pi/agent/pi-base.json` |
| Current project | `<repo>/.pi/pi-base.json` |

Ready-to-copy global configuration and Agent examples are in [`examples`](examples/); see the [Configuration Reference](docs/configuration.md) for all fields, default values, and merge rules. Run `/reload` after modifying the configuration.

## Agents and extensions

- Define [Markdown Agents](docs/agents.md) in `~/.pi/agent/agents/**/*.md` and use them with `pi --agent <name>` or `/agent <name>`.
- Declare delegable Agents in an Agent's `subagents` to enable [`task`](docs/tools/task.md).
- After configuring `mcp.servers`, you can use [local or remote MCP tools](docs/tools/mcp.md).
- Use `/goal <objective>` to create persistent, pausable, and resumable [Goals](docs/tools/goal-tools.md).
- Use `/mcp-status`, `/subagent`, and `/goal status` to view runtime status.

## Notes

- [Context compression](examples/#context-compression) is disabled by default; it replaces some old tool results sent to the model with placeholder text, and should be enabled only when a long session with dense tool output has created clear context pressure.
- Desktop notifications are supported on Linux and WSL; notifications are not enabled on other platforms.
- When the system lacks `fd` or `rg`, it attempts to download them from their GitHub Releases; set `PI_OFFLINE=1` to disable the download.
- `permission` reduces the risk of accidental operations; it is not a security sandbox. For strong isolation, use containers, restricted accounts, or system-level sandboxes.

See [docs/](docs/) for architecture, development, configuration, and tool implementation documentation.

## License

This project is licensed under the [MIT License](LICENSE), except for third-party components that are separately attributed.

See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) and [LICENSES](LICENSES/) for the sources, copyrights, and applicable licenses of third-party components.
