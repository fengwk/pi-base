<p align="center">
  🌐 <a href="task.md">English</a> · <a href="task.zh-CN.md">简体中文</a>
</p>

# `task`

[← 工具索引](README.zh-CN.md) · [公共架构](../architecture.zh-CN.md)

## 作用

创建或恢复一个 Subagent session，并把 `prompt` 交给指定 Markdown Agent 执行。

## 注入条件

`task` 不是始终可见。当前 Agent 必须：

1. 声明非空 `subagents` allowlist。
2. 当前 session depth 小于 `subagent.maxDepth`。

注入逻辑位于 [`src/agent-support.ts`](../../src/agent-support.ts)，工具实现位于 [`src/subagent/task-tool.ts`](../../src/subagent/task-tool.ts)。

## 参数

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `subagent_type` | 是 | — | allowlist 中的 Agent 名 |
| `prompt` | 是 | — | 交给 Subagent 执行的任务说明 |
| `maxTurns` | 否 | 配置值，默认 50 | 该调用的 soft-stop turn 预算 |
| `session_id` | 否 | — | 恢复已有 Subagent session |

Schema 由 [`src/subagent/schema.ts`](../../src/subagent/schema.ts) 按当前 workspace 的默认 `maxTurns` 构建。

## 执行链

```text
校验 required args
  -> Agent 是否存在
  -> 是否在当前 allowlist
  -> resume session 是否正在运行
  -> 预留 parent/root 并发槽位
  -> create/resume AgentSession
  -> 写入 Agent/depth/root entries
  -> 注册 SubagentRegistry
  -> 运行 + 进度监听
  -> completed/error/aborted result
```

Agent、allowlist 和 resume 状态校验在创建 session 和预留并发槽位之前完成。

## Session 创建

Factory 位于 [`src/subagent/runner.ts`](../../src/subagent/runner.ts)：

- 根据 cwd 计算 Subagent session 目录。
- 创建或恢复 Pi AgentSession。
- 绑定持久 extension。
- 写入当前 Agent state。
- 写入 depth 和 root session id。
- 检查 child 与 parent 是否加载同一 `pi-base` module instance。

仅通过父 session 的临时 `pi -e` flag 加载、而 child 无法继承同一 extension 时会 fail-fast。

## Resume

传入 `session_id` 时：

- 已运行中的 session 不能再次 resume。
- 同一 session 的并发 resume 通过进程级 reservation 阻止。
- 恢复时使用传入的 `subagent_type` 和恢复时加载的 Agent config。

## 并发

两层并发限制：

- `maxConcurrency`：单个 parent 的直接 child。
- `maxTotalConcurrency`：整个 root delegation tree。

创建前先预留并发槽位；Subagent 注册到 registry 后释放 pending reservation，reservation 在此期间计入并发限制。

## Depth

Root depth 为 1。Child 创建时使用：

```text
childDepth = parentDepth + 1
```

达到 `maxDepth` 后，Agent 不再获得 `task`。

## maxTurns

`maxTurns` 是 soft-stop：

- 达到预算后向 child 发送提示，要求未完成时返回阶段报告。
- 不会强制终止正在执行的工具。
- 如果 child 继续工具驱动，每额外 5 个有效 turn 再提醒一次。

达到 soft-stop 后，可使用该 `session_id` 恢复同一 child session 并继续执行。

## Idle timeout 与 abort

- `idleTimeoutMs` 只在 session 没有 assistant/session 活动时触发。
- 工具调用进行期间不触发 `idleTimeoutMs`。
- Parent 取消会传播到当前 child 及其 delegation subtree。
- 运行状态存储在进程级 `SubagentRegistry`，UI widget 和 `/subagent` 共用该 registry。

## Permission

Headless child 遇到 `ask` 时，将请求转发给 root UI 的 permission host。Root UI 不存在或 host 已失效时请求失败，不会隐式 allow。

## 结果

工具返回：

```xml
<task id="session-id" state="completed">
<task_result>...</task_result>
</task>
```

非 `completed` state 会设置 `isError: true`。`details.result` 保留结构化 session id、state 和输出。

## UI

- Root UI widget 展示运行中 parent/child 树和最近活动。
- `/subagent` 打开 session 选择器。
- `/subagent <id-or-prefix>` 只读查看 transcript。

## 相关测试

- [`tests/subagent-task-tool.test.ts`](../../tests/subagent-task-tool.test.ts)
- [`tests/subagent-runner.test.ts`](../../tests/subagent-runner.test.ts)
- [`tests/subagent-integration.test.ts`](../../tests/subagent-integration.test.ts)
- [`tests/subagent-task-injection.test.ts`](../../tests/subagent-task-injection.test.ts)
- [`tests/subagent-permission-relay.test.ts`](../../tests/subagent-permission-relay.test.ts)
- [`tests/subagent-widget.test.ts`](../../tests/subagent-widget.test.ts)
- [`tests/subagent-command.test.ts`](../../tests/subagent-command.test.ts)
