# 配置示例

| 示例文件 | 配置位置 |
|----------|----------|
| [`pi-base.json`](pi-base.json) | `~/.pi/agent/pi-base.json` 或项目的 `.pi/pi-base.json` |
| [`agents/*.md`](agents/) | `~/.pi/agent/agents/` |

`pi-base.json` 中的 LSP 命令从 `PATH` 查找。删除不使用的 server，或安装对应的 `jdtls`、`typescript-language-server`、`gopls` 和 `pylsp`。

Agent 示例使用以下模型：

| Agent | Model | Thinking level |
|-------|-------|----------------|
| `jiji` | `openai/gpt-5.6-sol` | `max` |
| `coder` | `deepseek/deepseek-v4-flash` | `max` |
| `explorer` | `deepseek/deepseek-v4-flash` | `high` |
| `helper` | `deepseek/deepseek-v4-flash` | `high` |

模型需要存在于 Pi 的模型配置中。可以在各 Agent 文件的 frontmatter 中替换 `model` 和 `thinkingLevel`。

配置字段见[配置参考](../docs/configuration.md)，Agent 字段见[Markdown Agent](../docs/agents.md)。
