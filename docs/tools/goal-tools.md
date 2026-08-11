# Goal tools

[← 工具索引](README.md) · [公共架构](../architecture.md)

## 作用

Goal mode 为根 session 提供可持久化、可暂停、可恢复的长期目标，并通过三个工具让模型读取和更新状态。

## 工具

| 工具 | 参数 | 作用 |
|------|------|------|
| `create_goal` | `objective`, optional `tokenBudget` | 创建或替换 Goal |
| `get_goal` | 无 | 读取当前 Goal 和剩余预算 |
| `update_goal` | `status`, `reason` | 标记 `complete` 或 `blocked` |

实现位于 [`src/goal/index.ts`](../../src/goal/index.ts)，状态模型位于 [`src/goal/state.ts`](../../src/goal/state.ts)。

## 注入策略

- Goal 只属于主 session。
- Subagent 不恢复 Goal，也不获得 Goal tools。
- 隐式/default Agent 可以获得 `create_goal`。
- 显式 tool allowlist 的 Agent 通常通过 `/goal` 创建，Goal active 后按运行时策略注入读取/更新工具。

## 状态

```text
active
paused
blocked
budget_limited
complete
```

持久化 `GoalState` 包含：

- `id`
- `objective`
- `status`
- `tokenBudget`
- `tokensUsed`
- `timeUsedSeconds`
- `createdAt`
- `updatedAt`

Snapshot 使用 session custom entry `pi-base-goal-state`。

## `create_goal`

Schema：

- `objective`：非空、持久且可验证的目标。
- `tokenBudget`：可选正数，只应在用户明确要求时设置。

执行：

1. trim objective。
2. 规范化预算。
3. 创建 version 1 GoalState。
4. 替换已有 Goal。
5. 持久化 snapshot。

工具只持久化状态，不额外注入一次 user goal-set message；`/goal` 命令路径会创建可见控制消息。

## `get_goal`

无参数，返回：

- 当前 Goal。
- 格式化状态。
- Remaining token 信息。

没有 Goal 时返回正常的空状态说明。

## `update_goal`

参数：

```text
status: complete | blocked
reason: non-empty evidence/rationale
```

限制：

- 没有 Goal 时失败。
- Goal 必须 active；budget wrap-up 是特殊例外。
- Budget-limited wrap-up 只能标记 complete。
- `reason` 必须非空。

工具持久化 status，但 `reason` 只用于当前调用的审计说明，不写入 GoalState。

## `/goal` 命令

```text
/goal [--tokens 50k] <objective>
/goal status
/goal edit <objective>
/goal pause
/goal resume
/goal clear
/goal statusbar [on|off]
```

Token budget 支持 `k` / `m` 后缀。

## 预算

每个主 session turn 统计：

```text
input + output + cacheWrite
```

`cacheRead` 不重复计入。达到预算后状态变为 `budget_limited`。

预算不会强制 abort 当前 run：

- 发送 soft-stop wrap-up guidance。
- 当前 run 可以完成收尾。
- Settled 后停止自动 continuation。
- 每额外 5 个工具驱动 turn 重发提示。

## 自动续跑

Active Goal 在 `agent_settled` 后检查：

- 已完成/blocked：停止。
- aborted：转 paused。
- 不可恢复 error：转 blocked。
- 仍 active：注入 continuation。

`Esc` 暂停后必须 `/goal resume` 才继续。Reload 会把 active Goal 改为 paused，防止重载后静默续跑。

## Context 过滤

Provider request 前会过滤：

- 旧 Goal control messages。
- aborted/error assistant messages。
- 已被新状态替代的 continuation。

只保留当前有效 Goal guidance。

## 相关测试

- [`tests/goal.test.ts`](../../tests/goal.test.ts)
- [`tests/goal-state.test.ts`](../../tests/goal-state.test.ts)
- [`tests/index-lifecycle.test.ts`](../../tests/index-lifecycle.test.ts)
