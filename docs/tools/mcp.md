# MCP 动态工具

[← 工具索引](README.md) · [公共架构](../architecture.md)

## 作用

连接本地或远程 MCP server，把 server 提供的 tools 动态适配为 Pi tools。

## 入口

- 注册与 lifecycle：[`src/mcp/register.ts`](../../src/mcp/register.ts)
- Hub：[`src/mcp/hub.ts`](../../src/mcp/hub.ts)
- Session binding：[`src/mcp/binding.ts`](../../src/mcp/binding.ts)
- SDK client：[`src/mcp/client.ts`](../../src/mcp/client.ts)
- Tool adapter：[`src/mcp/adapter.ts`](../../src/mcp/adapter.ts)
- JSON Schema 转换：[`src/mcp/schema.ts`](../../src/mcp/schema.ts)
- 配置类型：[`src/mcp/types.ts`](../../src/mcp/types.ts)

## 支持的 server

### Local

使用 stdio transport：

```json
{
  "type": "local",
  "command": ["my-mcp", "serve"],
  "cwd": "~/work/project",
  "env": {
    "API_KEY": "${API_KEY}"
  }
}
```

### Remote

支持：

- `streamable-http`
- `sse`
- `websocket`

WebSocket 不支持自定义 headers。

## 执行架构

```text
session_start
  -> processMcpHubRegistry.acquire(rootSessionId)
  -> McpHub.configure
  -> connect enabled servers
  -> listTools
  -> McpSessionBinding sync snapshot
  -> createMcpToolDefinition
  -> pi.registerTool
```

同一 root delegation tree 共享一个 Hub；不同 root session 使用独立 Hub。

## Hub 状态

Server 状态：

```text
disabled
idle
starting
connected
reconnecting
failed
```

Hub 负责：

- 首次连接。
- Tool 列表。
- Heartbeat。
- 断线检测。
- 指数式重试延迟。
- Call timeout。
- Terminal shutdown。

默认：

- startup timeout：60000 ms
- call timeout：60000 ms
- heartbeat：30000 ms
- retry delays：5s、10s、20s、40s、60s

## Tool 命名

默认别名：

```text
<serverKey>_<remoteToolName>
```

`toolPrefix`：

- 未设置：使用 server key。
- `""`：保留 remote tool name。
- 其他字符串：使用指定 prefix。

别名最大 64 字符。原始别名超过 64 字符或包含 `[A-Za-z0-9_-]` 之外的字符时，非法字符转换为 `_`，并追加 12 字符 SHA-256 hash。

## Schema

Remote `inputSchema` 通过 [`src/mcp/schema.ts`](../../src/mcp/schema.ts) 转换为 TypeBox。

不支持的 JSON Schema 结构转换为 `Type.Any()`；该工具仍会注册。

## Tool adapter

每个动态工具包含：

- Pi alias name。
- `<server>: <tool>` label。
- Remote description。
- 转换后的 parameters。
- JSON 参数 renderer。
- 默认 2500 字符的折叠结果上限。

执行时调用：

```text
callTool(serverKey, remoteToolName, args, ctx, signal)
```

## Result 转换

支持：

- Text。
- Base64 image。
- Structured content。
- 其他 MCP content item 的 JSON 文本表示。

Structured content 如果没有与现有 text 重复，会追加：

```text
[structured content]
<json>
```

空结果转换为 `No content returned.`。

Remote `isError` 和 transport 异常都映射为 Pi `isError: true`，并在 `details` 保留 server/tool。

## Binding 与工具冲突

`McpSessionBinding` 跟踪：

- alias owner。
- available aliases。
- unavailable/stale aliases。
- 连接恢复后需要重新激活的工具。

同名 alias 已被其他工具占用时标记为 `conflict`，不会覆盖现有工具。断线后工具可以标记 `stale`，重连并重新发现后恢复。

Agent tool allowlist 作用于 MCP alias。

## 环境变量

`env` 和 `headers` 只接受整个值引用：

```text
$VAR
${VAR}
```

不支持：

```text
Bearer ${TOKEN}
```

环境变量不存在时连接失败。

## 状态与命令

- Footer：`MCP: connected/total servers`
- `/mcp-status`：显示 server 状态、transport、prefix、错误、重试时间和 tool 状态。

## Lifecycle

- `session_start` 建立或重配 binding。
- Reload 使用新 config 重新绑定。
- Root terminal shutdown 释放 lease。
- Hub 没有使用者时关闭 transport 和本地进程。

## 相关测试

- [`tests/mcp.test.ts`](../../tests/mcp.test.ts)
- [`tests/mcp-client.test.ts`](../../tests/mcp-client.test.ts)
- [`tests/mcp-process-sharing.test.ts`](../../tests/mcp-process-sharing.test.ts)
- [`tests/mcp-adapter-status.test.ts`](../../tests/mcp-adapter-status.test.ts)
- [`tests/mcp-result-adapter.test.ts`](../../tests/mcp-result-adapter.test.ts)
- [`tests/mcp-schema.test.ts`](../../tests/mcp-schema.test.ts)
- [`tests/mcp-index-behavior.test.ts`](../../tests/mcp-index-behavior.test.ts)
