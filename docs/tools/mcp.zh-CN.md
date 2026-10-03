<p align="center">
  🌐 <a href="mcp.md">English</a> · <a href="mcp.zh-CN.md">简体中文</a>
</p>

# 原生 MCP 工具

[← 工具索引](README.zh-CN.md) · [架构](../architecture.zh-CN.md) · [迁移指南](../mcp-migration.zh-CN.md)

## 配置

Pi 1.0 原生 MCP 是唯一 MCP 实现。Server 配置写入
`~/.pi/agent/mcp.json`，不再写入 `pi-base.json`。可信项目也可使用 `.pi/mcp.json`；
项目条目会替换同名全局条目。

pi-base 根 session 和子代理应使用显式 `direct` 暴露；这与 `codemode` 是否注册或激活独立：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "exposure": "direct"
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "timeout": 60,
      "exposure": "direct"
    }
  }
}
```

本地 server 使用 stdio，远程 server 使用 streamable HTTP；不支持 SSE 和 WebSocket。
`timeout` 单位为秒。连接前应核对启动命令和凭证引用；
通过 `/mcp` 管理服务，通过 `pi mcp list` 查看工具。

## 命名与暴露

官方名称通常为 `mcp__<server>__<tool>`。Pi 会清洗非法字符，并为过长或冲突的名称
追加 hash 后缀。应使用实际注册名称，而不是自行推测旧别名。

`direct` 将工具直接声明给模型。省略 exposure 时，原生 Pi 默认为 `codemode`；
在本集成中选择它需单独配置，并非迁移默认行为。
暴露模式控制模型呈现，不等同于执行授权。

## 原生发现配置

Pi 1.0 的 `codemode` 为 `defaultActive=false`。若需启用它并禁用 tool search，
将以下示例合并到原生 `~/.pi/agent/settings.json` 或可信项目的
`.pi/settings.json`，而不是 `pi-base.json`：

```json
{
  "defaultTools": ["+codemode"],
  "extensions": ["-builtin:tool-search"]
}
```

扩展加载与工具激活是独立控制项。pi-base 遵循原生 settings，
不会强制激活工具或覆盖 `defaultTools`。
即使启用了 `codemode`，需要直接声明 MCP 工具时仍应在 `mcp.json`
中保留 `exposure: "direct"`。

## 调用链与 Agent 策略

```text
Pi 原生 MCP 注册
  -> before_agent_start / turn_start：同步 Agent 工具选择
  -> tool_call：pi-base Markdown Agent 执行 guard
  -> permission guard
  -> 原生 MCP 调用及结果
```

- 可以在异步注册完成前将 MCP 名称写入 allowlist。
  `session_start` 不会仅因工具尚未就绪而警告。
  工具选择在 `before_agent_start` 和 `turn_start` 同步，而非等待一次性的
  “初次连接结束”回调；执行入口仍会检查授权。
- pi-base Markdown Agent 的显式 `tools` 列表按精确名称授权普通工具；
  direct MCP 调用应列出官方 MCP 名称。
- 若另行启用 `codemode` 或 `tool_search`，需同时授权封装工具和允许其调用的
  MCP 工具；封装调用不能绕过 Agent 执行 guard。
- `tools: []` 表示空的**普通工具** allowlist；已有 runtime hook 仍可在各自条件
  满足时注入 `task` 或 Goal 工具。
- 上述执行限制由 pi-base Markdown Agent guard 实现；
  不应泛化为官方 SDK `tools` 选项的通用保证。

## 子代理与延伸阅读

pi-base SDK 子 session 将 `createMcpExtension()`、`createCodemodeExtension()`
和 `createToolSearchExtension()` 作为 builtin、replaceable factory 提供给原生
resource loader，名称分别为 `mcp`、`codemode` 和 `tool-search`。
加载遵循全局及可信项目 `settings.json` 的扩展启禁配置。
注册不等于强制激活：工具组合由原生 `defaultTools` 与子 Agent 自身工具策略决定，
不复制父 session 的 active tools。直接声明 MCP 工具应配置 `exposure: "direct"`，
并将名称写入子 Agent 自身的 allowlist。每个 session 独立持有和释放连接，
不共享父子 MCP hub。

OAuth、其他可选暴露模式和通用 SDK 配置参见
[Pi 官方 MCP 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)。
[迁移指南](../mcp-migration.zh-CN.md)记录 Pi 0.99.1 引入原生 MCP 的历史，
也是离线迁移 CLI、别名映射、备份及安全限制的唯一详细说明；
当前 Pi 1.0 子 session 行为以本页为准。
