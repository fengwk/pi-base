<p align="center">
  🌐 <a href="agents.md">English</a> · <a href="agents.zh-CN.md">简体中文</a>
</p>

# Markdown Agent

[文档首页](README.zh-CN.md) · [架构概览](architecture.zh-CN.md) · [配置参考](configuration.zh-CN.md)

`pi-base` 可以从 Markdown 文件加载具名 Agent，为不同任务固定 system prompt、模型、思考级别、工具、skills 和可委派的 Subagent。

Agent 示例见 [`examples/agents`](../examples/agents/)。

## 文件位置

默认目录：

```text
~/.pi/agent/agents/**/*.md
```

目录会递归扫描 `.md` 文件。Agent catalog 在 session 启动以及执行 `/agent` 时重新加载。

内置 `default` Agent 不来自该目录；它使用 `~/.pi/agent/SYSTEM.md` 和 Pi 的默认模型设置。自定义 Agent 不能使用保留名称 `default`。

## 最小示例

```markdown
---
name: reviewer
description: Review code without modifying files
tools:
  - read
  - grep
  - lsp_goto_definition
---

You are a read-only code reviewer.
```

Frontmatter 之后的 Markdown 正文作为该 Agent 的自定义 prompt。正文为空时继续使用默认 system prompt。

## Frontmatter 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 否 | Agent 名；省略时使用文件名，不含 `.md` |
| `description` | 否 | `/agent` 选择器和 Subagent 列表中的简介 |
| `model` | 否 | `provider/model` 格式；找不到模型时保留当前 session 模型并警告 |
| `thinkingLevel` | 否 | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |
| `tools` | 否 | 当前 Agent 可使用的工具名数组 |
| `skills` | 否 | 对模型可见的 skill 名数组 |
| `subagents` | 否 | 允许通过 `task` 委派的 Agent 名数组 |

未知字段会使整个 Agent 文件失效。字符串数组会去重；空字符串或非数组值会使文件失效。

## Tool allowlist

- 省略 `tools`：继承当前默认工具策略。
- 显式数组：只保留当前已注册且匹配的工具。
- 空数组：不提供普通工具。
- 文件修改工具会结合当前模型做投影，但不会扩大显式 allowlist。
- MCP 等动态工具可以预先写入 allowlist；初次连接成功后再进行可用性校验。

当前不可用的工具会产生警告，但名称不会从 allowlist 删除；工具后续注册或 MCP 重连成功后仍可激活。MCP 首次连接失败时，该工具在当前启动阶段标记为不可用并产生警告。

## Skill allowlist

- 省略 `skills`：使用当前可供模型调用的 skills。
- 显式数组：只注入匹配名称的 skills。
- 空数组：不注入 skills。
- 标记为禁止模型调用的 skill 不会进入 system prompt。
- `read` 不在当前工具集时，不向 system prompt 注入 skills。

Skills 通过 prompt 告诉模型何时加载对应 `SKILL.md`；它们不是 Pi tools。

## Subagent allowlist

`subagents` 中只能引用已加载的 Agent。未知名称会被忽略并产生 catalog warning。

`task` 只在以下条件同时满足时注入：

1. 当前 Agent 的 `subagents` 非空。
2. 当前 session depth 小于 `subagent.maxDepth`。
3. `task` 工具在当前 session 可用。

并发、恢复、`maxTurns` 和权限中继见 [`task`](tools/task.zh-CN.md)。

## 选择与切换

Session 启动时的 Agent 选择优先级：

```text
当前 session 已持久化 Agent
  > --agent
  > pi-base.json defaultAgent
  > built-in default
```

第一项只在恢复或继承了 Agent state 的 session 中存在；全新 session 从 `--agent` 开始判断。

选择与切换命令：

```bash
pi --agent reviewer
```

```text
/agent reviewer
/agent default
/agent
```

无参数 `/agent` 在交互式 UI 中打开选择器。恢复已有 session 时，持久化的 Agent 优先于 `--agent`；恢复过程保留该 session 当前的模型和 thinking level。

## 诊断

- 重复 Agent 名：保留先加载的定义，忽略后续文件。
- Frontmatter 无效：忽略该文件并显示 warning。
- 未知 tool：保留 allowlist 名称并警告，允许后续动态注册。
- 未知 skill：保持隐藏并警告。
- 未知 subagent：从 allowlist 移除并警告。
- 模型不存在或无法激活：保留当前 session 模型。

## 相关实现与测试

- [`src/agent-support.ts`](../src/agent-support.ts)
- [`tests/agent-support.test.ts`](../tests/agent-support.test.ts)
- [`tests/subagent-task-injection.test.ts`](../tests/subagent-task-injection.test.ts)
