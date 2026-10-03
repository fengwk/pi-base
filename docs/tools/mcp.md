<p align="center">
  🌐 <a href="mcp.md">English</a> · <a href="mcp.zh-CN.md">简体中文</a>
</p>

# Native MCP Tools

[← Tool index](README.md) · [Architecture](../architecture.md) · [Migration guide](../mcp-migration.md)

## Configuration

Pi 1.0 native MCP is the sole MCP implementation. Configure servers in
`~/.pi/agent/mcp.json`, not `pi-base.json`. Trusted projects may use `.pi/mcp.json`;
project entries replace global entries of the same name.

Use explicit `direct` exposure for pi-base root sessions and subagents; this is independent of whether `codemode` is registered or active:

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

Local servers use stdio; remote servers use streamable HTTP. SSE and WebSocket are
unsupported. `timeout` is in seconds. Review commands and credential references
before connecting; manage servers with `/mcp` and inspect tools with `pi mcp list`.

## Names and exposure

Official names normally follow `mcp__<server>__<tool>`. Pi sanitizes unsupported
characters and adds a hash suffix for overlong or colliding names. Use the actual
registered name, not a guessed legacy alias.

`direct` declares tools directly to the model. Native Pi defaults to `codemode`
when exposure is omitted; choosing it is a separate opt-in for this integration,
not the migration default. Exposure controls presentation, not execution permission.

## Native discovery settings

Pi 1.0 `codemode` has `defaultActive=false`. To enable it and disable tool search,
merge this example into native `~/.pi/agent/settings.json` or trusted-project
`.pi/settings.json`, not `pi-base.json`:

```json
{
  "defaultTools": ["+codemode"],
  "extensions": ["-builtin:tool-search"]
}
```

Extension loading and tool activation are separate controls. pi-base honors the
native settings rather than forcing tools active or overriding `defaultTools`.
Keep `exposure: "direct"` in `mcp.json` when direct MCP declarations are desired,
even if `codemode` is enabled.

## Call chain and Agent policy

```text
Pi native MCP registration
  -> before_agent_start / turn_start: synchronize Agent tool selection
  -> tool_call: pi-base Markdown Agent execution guard
  -> permission guard
  -> native MCP call and result
```

- MCP names may be listed before their asynchronous registration completes.
  `session_start` does not warn merely because a tool is not ready.
  Selection is synchronized at `before_agent_start` and `turn_start`, not by a
  one-time “initial connection finished” callback; execution is checked at entry.
- A pi-base Markdown Agent's explicit `tools` list authorizes ordinary tools by
  exact name. For direct MCP calls, list the canonical MCP names.
- If you separately enable `codemode` or `tool_search`, authorize both the wrapper
  and the MCP tools it may invoke. Wrappers do not bypass the Agent execution guard.
- `tools: []` is an empty **ordinary** allowlist. Existing runtime hooks may still
  inject `task` or Goal tools when their own conditions are met.
- These execution restrictions belong to pi-base's Markdown Agent guard; they
  are not a general guarantee of the official SDK's `tools` option.

## Subagents and further reading

pi-base SDK child sessions provide `createMcpExtension()`, `createCodemodeExtension()`,
and `createToolSearchExtension()` to the native resource loader as built-in,
replaceable factories named `mcp`, `codemode`, and `tool-search`. Loading follows
global and trusted-project `settings.json` extension enable/disable settings.
Registration does not force activation: native `defaultTools` and the child
Agent's own tool policy determine the loadout, not a copy of the parent's active
tools. Configure direct MCP declarations with `exposure: "direct"` and authorize
names in the child Agent's own allowlist. Each session owns and disposes its
connections; there is no shared parent/child MCP hub.

See the [official Pi MCP documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)
for OAuth, optional exposure modes, and generic SDK setup. The
[migration guide](../mcp-migration.md) records the historical Pi 0.99.1 native MCP
introduction and is the sole detailed reference for the offline migration CLI,
alias maps, backups, and safety limits; use this page for current Pi 1.0 child-session behavior.
