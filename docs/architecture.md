<p align="center">
  🌐 <a href="architecture.md">English</a> · <a href="architecture.zh-CN.md">简体中文</a>
</p>

# Architecture

## Extension entry point

The package entry is [`index.ts`](../index.ts); the actual initialization is done by `piBaseExtension` in [`src/index-impl.ts`](../src/index-impl.ts).

```text
Pi
  -> index.ts
  -> piBaseExtension(pi, options)
     -> Load runtime configuration
     -> Register base tools
     -> Register Agent / Goal / Notify
     -> Register MCP / Subagent / Permission
     -> Register lifecycle hooks
```

`package.json` points to `index.ts` via `pi.extensions`. The extension itself does not start a separate process; all capabilities are mounted onto the current Pi session.

## Initialization order

`piBaseExtension` registers components in the following order:

1. Register compaction model support.
2. Create an LSP resolver factory that loads configuration by working directory.
3. Register session reload, shutdown, and LSP cleanup logic.
4. Register base tools:
   - `read`
   - `grep`
   - `find`
   - `bash`
   - `edit`
   - `write`
   - `apply_patch`
   - three LSP tools
5. Register the Markdown Agents and the `--agent` flag.
6. Register Goal, Notify, MCP, and Subagent.
7. Register the Permission guard, `/yolo`, `/resume-all`, and `/subagent`.
8. Register context compression, provider request, and the unified `tool_result` hooks.

Registration order is constrained by the following dependencies: Goal's settled handler is registered before Notify; Permission reuses Notify's permission callback; Subagent is registered after the Agent catalog can provide allowlists.

## Modules

| Module | Responsibility |
|--------|----------------|
| [`src/index-impl.ts`](../src/index-impl.ts) | Extension wiring, tool registration, and lifecycle orchestration |
| [`src/config.ts`](../src/config.ts) | Configuration parsing, validation, path normalization, and merging |
| [`src/runtime-settings.ts`](../src/runtime-settings.ts) | Per-cwd cached runtime configuration and YOLO state |
| [`src/agent-support.ts`](../src/agent-support.ts) | Markdown Agent loading, switching, and tool and skill allowlists |
| [`src/subagent/`](../src/subagent/) | `task`, session creation/resumption, concurrency, permission relay, and UI |
| [`src/goal/`](../src/goal/) | Persistent Goals, budget, auto-resume, and control tools |
| [`src/lsp/`](../src/lsp/) | LSP discovery, client pool, and tool implementations |
| [`src/mcp/`](../src/mcp/) | MCP transport, hub, binding, schema, and dynamic tools |
| [`src/permission.ts`](../src/permission.ts) | Tool call permission matching and confirmation |
| [`src/context-compression.ts`](../src/context-compression.ts) | Compression of old tool results and file anchor cleanup |
| [`src/tool-output-core.ts`](../src/tool-output-core.ts) | Unified output truncation and full-result persistence |
| [`src/render.ts`](../src/render.ts) | Common call/result rendering and collapsing |

## Session lifecycle

### session_start

At root session startup or reload:

- Load or invalidate the `pi-base.json` cache.
- Clear the LSP resolver cache; close existing LSP clients on reload.
- Restore the current Agent, Goal, and runtime state.
- Establish MCP bindings.
- After the initial MCP connection and tool discovery phase, validate the current Agent's tool allowlist.
- Register the Subagent permission host, diagnostics host, and live tree widget on the UI root session.

Subagent sessions carry their own depth, root session id, and Agent state, and do not duplicate root UI resources.

### session_shutdown

- The root session closes all LSP clients.
- MCP leases release shared connections at terminal shutdown.
- Clean up notifications, permission hosts, widgets, and the diagnostics host.
- Reload and terminal shutdown use different cleanup paths; reload does not release resources that continue to be reused after the reload.

### before_agent_start

The Agent module, based on the current Agent:

- Selects the system prompt.
- Applies the tool allowlist.
- Injects visible skills.
- Injects `task` when the depth and allowlist conditions are met.
- Adds `<available_subagents>` and `<env>`.

### tool_call

The Permission guard runs before tool execution:

```text
tool args
  -> target description or Bash command analysis
  -> global/tool-specific rules
  -> allow / ask / deny
  -> optional root UI confirmation
```

Permission evaluation is skipped when YOLO is enabled.

### tool_result

All tool results eventually go through the same processing chain:

```text
tool result
  -> infer/fix isError
  -> detect upstream truncation
  -> apply the final 2000-line / 50 KiB limit
  -> save full text when necessary
```

The implementation is in [`src/tool-result.ts`](../src/tool-result.ts), [`src/tool-error-marker.ts`](../src/tool-error-marker.ts), and [`src/tool-output-core.ts`](../src/tool-output-core.ts).

## Runtime commands

| Command | Purpose | Details |
|---------|---------|---------|
| `/agent [name]` | Select or switch the Markdown Agent; `/agent default` restores the built-in default Agent | [Markdown Agents](agents.md) |
| `/goal ...` | Create, view, pause, resume, or end a long-term Goal | [Goal tools](tools/goal-tools.md) |
| `/mcp-status` | View MCP server, connection, retry, and dynamic tool status | [MCP dynamic tools](tools/mcp.md) |
| `/subagent [id-or-prefix]` | View running Subagent sessions in the root TUI | [`task`](tools/task.md) |
| `/yolo` | Toggle the current runtime's Permission bypass without writing back to configuration | [Configuration reference](configuration.md#yolo) |
| `/resume-all` | Select and resume a session in any project directory from the interactive UI | [`src/resume-all.ts`](../src/resume-all.ts) |

## Shared tool structure

Static tools share the following execution layering:

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

Related shared modules:

- Schema: [`src/schemas/`](../src/schemas/)
- Prompt: [`prompts/`](../prompts/)
- Paths: [`src/path-utils.ts`](../src/path-utils.ts)
- Argument aliases: [`src/tool-arg-aliases.ts`](../src/tool-arg-aliases.ts)
- Runtime abort: [`src/runtime.ts`](../src/runtime.ts)
- Timeout: [`src/timeout.ts`](../src/timeout.ts)
- Text encoding: [`src/text-codec.ts`](../src/text-codec.ts)
- Line endings: [`src/line-endings.ts`](../src/line-endings.ts)

## Paths and file writes

Path-based tools support:

- Relative paths, based on `workdir` or the current session cwd.
- Absolute paths.
- `~/`, `$HOME/`, `${HOME}/`.
- Compatible alias mapping from `filePath` to `path`.

`edit`, `write`, and `apply_patch` use a file change queue to serialize the read-modify-write process for the same target. Text files uniformly go through encoding detection. The Update/Move of `edit` and `apply_patch` preserves the existing encoding, BOM, and line endings; `write` preserves the encoding and BOM when overwriting an existing file, while line breaks follow the passed `content`.

`permission` is a lexical safeguard against accidental misuse, not a filesystem sandbox. When security isolation is required, containers, restricted accounts, or OS-level boundaries must be used.

## Dynamic tools

### Model-driven file tool projection

`edit`, `write`, and `apply_patch` are all registered. When no file modification tool is specified in the Agent's `tools`, models whose ID contains `gpt-` and not `gpt-4` or `oss` use `apply_patch`; other models use `edit` and `write`.

Explicit configuration does not expand permissions. When both `apply_patch` and `edit`/`write` are configured, only `apply_patch` is enabled; models whose ID contains `gpt-` and not `gpt-4` or `oss` also use `apply_patch` when both `edit` and `write` are configured; when only `edit` or `write` is configured, that single tool is kept.

### MCP

MCP tools come from the runtime server list; there is no fixed tool name. `McpSessionBinding` converts server schemas into Pi tool definitions and handles aliases, conflicts, disconnections, and recovery.

### Subagent

`task` is injected only when the current Agent declares a non-empty `subagents` and the depth has not reached the limit.

### Goal

The root session can obtain `create_goal`; once a Goal is active, `get_goal` and `update_goal` are injected according to the Agent tool policy. Goal tools are not injected into Subagents.

## Process-level and session-level state

| State | Scope |
|-------|-------|
| Configuration cache | In-process, per cwd |
| LSP manager | In-process client pool |
| MCP hub registry | In-process, per root session tree |
| Subagent registry | In-process |
| Agent state | session entry |
| Goal state | root session entry |
| YOLO | Runtime cwd configuration snapshot |

## Third-party boundaries

[`src/internal/pi-coding-agent-utils.ts`](../src/internal/pi-coding-agent-utils.ts) contains internal helpers derived from `pi-coding-agent`; the `apply_patch` grammar is derived from OpenAI Codex. Sources and licenses are in [`THIRD_PARTY_NOTICES`](../THIRD_PARTY_NOTICES).
