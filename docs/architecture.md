# 架构概览

## 扩展入口

包入口是 [`index.ts`](../index.ts)，实际初始化由 [`src/index-impl.ts`](../src/index-impl.ts) 中的 `piBaseExtension` 完成。

```text
Pi
  -> index.ts
  -> piBaseExtension(pi, options)
     -> 加载运行时配置
     -> 注册基础工具
     -> 注册 Agent / Goal / Notify
     -> 注册 MCP / Subagent / Permission
     -> 注册生命周期钩子
```

`package.json` 通过 `pi.extensions` 指向 `index.ts`。扩展本身不启动独立进程；所有能力都挂载到当前 Pi session。

## 初始化顺序

`piBaseExtension` 的主要初始化顺序如下：

1. 注册 compaction model 支持。
2. 创建按工作目录加载配置的 LSP resolver factory。
3. 注册 session reload、shutdown 与 LSP 清理逻辑。
4. 注册基础工具：
   - `read`
   - `grep`
   - `find`
   - `bash`
   - `edit`
   - `write`
   - `apply_patch`
   - 三个 LSP 工具
5. 注册 Markdown Agent 和 `--agent` flag。
6. 注册 Goal、Notify、MCP 和 Subagent。
7. 注册 Permission guard、`/yolo`、`/resume-all`、`/subagent`。
8. 注册 context compression、provider request 和统一 `tool_result` 钩子。

顺序是有意义的。例如 Goal 的 settled handler 必须先于 Notify 判断一次运行是否真正结束；Permission 需要复用 Notify 的 permission 回调；Subagent 需要 Agent catalog 提供 allowlist。

## 主要模块

| 模块 | 职责 |
|------|------|
| [`src/index-impl.ts`](../src/index-impl.ts) | 扩展 wiring、工具注册和生命周期编排 |
| [`src/config.ts`](../src/config.ts) | 配置解析、校验、路径规范化与合并 |
| [`src/runtime-settings.ts`](../src/runtime-settings.ts) | 按 cwd 缓存运行时配置和 YOLO 状态 |
| [`src/agent-support.ts`](../src/agent-support.ts) | Markdown Agent 加载、切换、工具与 skill allowlist |
| [`src/subagent/`](../src/subagent/) | `task`、session 创建/恢复、并发、权限中继和 UI |
| [`src/goal/`](../src/goal/) | 持久化 Goal、预算、自动续跑和控制工具 |
| [`src/lsp/`](../src/lsp/) | LSP discovery、client pool 和工具实现 |
| [`src/mcp/`](../src/mcp/) | MCP transport、hub、binding、schema 和动态工具 |
| [`src/permission.ts`](../src/permission.ts) | 工具调用权限匹配和确认 |
| [`src/context-compression.ts`](../src/context-compression.ts) | 旧工具结果压缩与文件锚点清理 |
| [`src/tool-output-core.ts`](../src/tool-output-core.ts) | 统一输出截断和完整结果落盘 |
| [`src/render.ts`](../src/render.ts) | 公共调用/结果渲染与折叠 |

## Session 生命周期

### `session_start`

根 session 启动或 reload 时会：

- 加载或失效 `pi-base.json` 缓存。
- 清理 LSP resolver cache；reload 时关闭已有 LSP client。
- 恢复当前 Agent、Goal 和运行时状态。
- 建立 MCP binding。
- MCP 初次连接与工具发现阶段结束后，再校验当前 Agent 的 tool allowlist，避免正常启动期间动态工具尚未注册时产生误报。
- 在 UI root session 注册 Subagent 权限 host、诊断 host 和实时树形 widget。

Subagent session 携带自己的 depth、root session id 和 Agent state，不重复拥有 root UI 资源。

### `session_shutdown`

- 根 session 关闭全部 LSP client。
- MCP lease 在 terminal shutdown 时释放共享连接。
- 清理通知、权限 host、widget 和诊断 host。
- reload 与真正退出采用不同的清理路径，避免重载过程中提前销毁仍需复用的资源。

### `before_agent_start`

Agent 模块根据当前 Agent：

- 选择 system prompt。
- 应用 tool allowlist。
- 注入可见 skills。
- 在满足 depth 和 allowlist 条件时注入 `task`。
- 添加 `<available_subagents>` 和 `<env>`。

### `tool_call`

Permission guard 在工具执行前运行：

```text
tool args
  -> 目标描述或 Bash 命令分析
  -> global/tool-specific rules
  -> allow / ask / deny
  -> 可选 root UI 确认
```

YOLO 启用时跳过权限评估。

### `tool_result`

所有工具结果最终进入同一处理链：

```text
tool result
  -> 推断/修复 isError
  -> 识别上游截断
  -> 应用 2000 行 / 50 KiB 最终限制
  -> 必要时保存完整文本
```

实现位于 [`src/tool-result.ts`](../src/tool-result.ts)、[`src/tool-error-marker.ts`](../src/tool-error-marker.ts) 和 [`src/tool-output-core.ts`](../src/tool-output-core.ts)。

## 运行时命令

| 命令 | 作用 | 详细说明 |
|------|------|----------|
| `/agent [name]` | 选择或切换 Markdown Agent；`/agent default` 恢复内置默认 Agent | [Markdown Agent](agents.md) |
| `/goal ...` | 创建、查看、暂停、恢复或结束长期 Goal | [Goal tools](tools/goal-tools.md) |
| `/mcp-status` | 查看 MCP server、连接、重试和动态工具状态 | [MCP 动态工具](tools/mcp.md) |
| `/subagent [id-or-prefix]` | 在 root TUI 中查看运行中的 Subagent session | [`task`](tools/task.md) |
| `/yolo` | 切换当前运行时的 Permission bypass，不写回配置 | [配置参考](configuration.md#yolo) |
| `/resume-all` | 在交互式 UI 中选择并恢复任意项目目录的 session | [`src/resume-all.ts`](../src/resume-all.ts) |

## 工具公共结构

大部分静态工具采用相同分层：

```text
schema
  -> register function
  -> prepareArguments
  -> renderCall
  -> execute
  -> renderResult
  -> error marker
  -> global tool_result hook
```

相关公共模块：

- Schema：[`src/schemas/`](../src/schemas/)
- Prompt：[`prompts/`](../prompts/)
- 路径：[`src/path-utils.ts`](../src/path-utils.ts)
- 参数别名：[`src/tool-arg-aliases.ts`](../src/tool-arg-aliases.ts)
- Runtime abort：[`src/runtime.ts`](../src/runtime.ts)
- Timeout：[`src/timeout.ts`](../src/timeout.ts)
- 文本编码：[`src/text-codec.ts`](../src/text-codec.ts)
- 行尾：[`src/line-endings.ts`](../src/line-endings.ts)

## 路径与文件写入

路径类工具支持：

- 相对路径，基于 `workdir` 或当前 session cwd。
- 绝对路径。
- `~/`、`$HOME/`、`${HOME}/`。
- `filePath` 到 `path` 的兼容别名映射。

`edit`、`write` 和 `apply_patch` 使用文件变更队列串行化同一目标的读改写过程。文本文件统一经过编码检测；修改工具尽量保留已有编码、BOM 和行尾。

`permission` 是词法防误操作机制，不是文件系统沙箱。需要安全隔离时必须使用容器、受限账户或操作系统级边界。

## 动态工具

### 模型驱动的文件工具投影

`edit`、`write` 和 `apply_patch` 都会注册，但当前 Agent 的实际工具集会按模型和显式 allowlist 投影：

- GPT/Codex 类模型默认使用 `apply_patch`。
- 其他模型默认使用 `edit` / `write`。
- 显式 Agent allowlist 不会被扩大权限。

### MCP

MCP 工具来自运行时 server 列表，不存在固定工具名。`McpSessionBinding` 将 server schema 转成 Pi tool definition，并处理别名、冲突、断线和恢复。

### Subagent

`task` 只在当前 Agent 声明非空 `subagents` 且 depth 未达到上限时注入。

### Goal

根 session 可获得 `create_goal`；Goal active 后按 Agent 工具策略注入 `get_goal` 和 `update_goal`。Goal 工具不注入 Subagent。

## 进程级与 Session 级状态

| 状态 | 作用域 |
|------|--------|
| 配置 cache | 进程内，按 cwd |
| LSP manager | 进程内 client pool |
| MCP hub registry | 进程内，按 root session tree |
| Subagent registry | 进程内 |
| Agent state | session entry |
| Goal state | root session entry |
| YOLO | 运行时 cwd 配置快照 |

设计目标是让同一 root delegation tree 共享昂贵资源，同时避免不同 root session 互相污染。

## 第三方边界

[`src/internal/pi-coding-agent-utils.ts`](../src/internal/pi-coding-agent-utils.ts) 包含从 `pi-coding-agent` 派生的内部 helper；`apply_patch` grammar 派生自 OpenAI Codex。来源和许可证见 [`THIRD_PARTY_NOTICES`](../THIRD_PARTY_NOTICES)。
