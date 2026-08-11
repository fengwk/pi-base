<p align="center">
  🌐 <a href="mcp.md">English</a> · <a href="mcp.zh-CN.md">简体中文</a>
</p>

# MCP Dynamic Tools

[← Tool index](README.md) · [Shared architecture](../architecture.md)

## Purpose

Connect to local or remote MCP servers and dynamically adapt the tools they provide into Pi tools.

## Entry point

- Registration and lifecycle: [`src/mcp/register.ts`](../../src/mcp/register.ts)
- Hub: [`src/mcp/hub.ts`](../../src/mcp/hub.ts)
- Session binding: [`src/mcp/binding.ts`](../../src/mcp/binding.ts)
- SDK client: [`src/mcp/client.ts`](../../src/mcp/client.ts)
- Tool adapter: [`src/mcp/adapter.ts`](../../src/mcp/adapter.ts)
- JSON Schema conversion: [`src/mcp/schema.ts`](../../src/mcp/schema.ts)
- Configuration types: [`src/mcp/types.ts`](../../src/mcp/types.ts)

## Supported servers

### Local

Uses the stdio transport:

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

Supported:

- `streamable-http`
- `sse`
- `websocket`

WebSocket does not support custom headers.

## Execution architecture

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

A single root delegation tree shares one Hub; different root sessions use independent Hubs.

## Hub states

Server states:

```text
disabled
idle
starting
connected
reconnecting
failed
```

The Hub is responsible for:

- First connection.
- Tool listing.
- Heartbeat.
- Disconnect detection.
- Exponential retry delays.
- Call timeout.
- Terminal shutdown.

Defaults:

- startup timeout: 60000 ms
- call timeout: 60000 ms
- heartbeat: 30000 ms
- retry delays: 5s, 10s, 20s, 40s, 60s

## Tool naming

Default alias:

```text
<serverKey>_<remoteToolName>
```

`toolPrefix`:

- Unset: uses the server key.
- `""`: keeps the remote tool name.
- Any other string: uses the specified prefix.

Aliases are at most 64 characters. When the original alias exceeds 64 characters or contains characters outside `[A-Za-z0-9_-]`, invalid characters are converted to `_` and a 12-character SHA-256 hash is appended.

## Schema

The remote `inputSchema` is converted to TypeBox via [`src/mcp/schema.ts`](../../src/mcp/schema.ts).

Unsupported JSON Schema constructs are converted to `Type.Any()`; the tool is still registered.

## Tool adapter

Each dynamic tool contains:

- Pi alias name.
- `<server>: <tool>` label.
- Remote description.
- Converted parameters.
- JSON parameters renderer.
- Collapsed result cap of 2500 characters by default.

On execution it calls:

```text
callTool(serverKey, remoteToolName, args, ctx, signal)
```

## Result conversion

Supported:

- Text.
- Base64 image.
- Structured content.
- JSON text representation of other MCP content items.

If structured content does not duplicate existing text, it is appended:

```text
[structured content]
<json>
```

Empty results are converted to `No content returned.`

Remote `isError` and transport exceptions both map to Pi `isError: true`, keeping server/tool in `details`.

## Binding and tool conflicts

`McpSessionBinding` tracks:

- alias owner.
- available aliases.
- unavailable/stale aliases.
- tools that need to be reactivated after connection recovery.

When an alias with the same name is already occupied by another tool, it is marked as `conflict` and does not override the existing tool. After a disconnect, tools can be marked `stale` and are restored after reconnection and rediscovery.

The agent tool allowlist applies to MCP aliases.

## Environment variables

`env` and `headers` only accept whole-value references:

```text
$VAR
${VAR}
```

Not supported:

```text
Bearer ${TOKEN}
```

Connection fails when the environment variable does not exist.

## Status and commands

- Footer: `MCP: connected/total servers`
- `/mcp-status`: shows server status, transport, prefix, errors, retry time, and tool status.

## Lifecycle

- `session_start` establishes or reconfigures the binding.
- Reload rebinds with the new config.
- Root terminal shutdown releases the lease.
- When the Hub has no consumers, the transport and local processes are shut down.

## Related tests

- [`tests/mcp.test.ts`](../../tests/mcp.test.ts)
- [`tests/mcp-client.test.ts`](../../tests/mcp-client.test.ts)
- [`tests/mcp-process-sharing.test.ts`](../../tests/mcp-process-sharing.test.ts)
- [`tests/mcp-adapter-status.test.ts`](../../tests/mcp-adapter-status.test.ts)
- [`tests/mcp-result-adapter.test.ts`](../../tests/mcp-result-adapter.test.ts)
- [`tests/mcp-schema.test.ts`](../../tests/mcp-schema.test.ts)
- [`tests/mcp-index-behavior.test.ts`](../../tests/mcp-index-behavior.test.ts)
