<p align="center">
  🌐 <a href="mcp-migration.md">English</a> · <a href="mcp-migration.zh-CN.md">简体中文</a>
</p>

# MCP Migration Guide: Migrating from Custom MCP to Pi 0.99.1 Native MCP

[← Documentation home](README.md) · [Native MCP tool reference](tools/mcp.md) · [Configuration reference](configuration.md)

This guide explains how to migrate existing MCP configurations and Agent definitions from the legacy `pi-base` custom MCP implementation to Pi 0.99.1 native MCP.

## Overview

In Pi 0.99.1, native MCP is integrated directly into the core runtime. `pi-base` adopts native MCP as the **sole** MCP implementation, retiring the legacy custom architecture (`src/mcp/hub.ts`, `src/mcp/binding.ts`, process-wide hub registry, connection leases, `/mcp-status`, and custom tool aliases). There is no dual-support mode.

## Key Changes and Architecture Comparison

| Aspect | Legacy `pi-base` Custom MCP | Pi 0.99.1 Native MCP |
|--------|-----------------------------|----------------------|
| **Configuration file** | `~/.pi/agent/pi-base.json` (`mcp` block) or `<repo>/.pi/pi-base.json` | `~/.pi/agent/mcp.json` (global) or `<project>/.pi/mcp.json` (trusted project) |
| **Top-level key** | `"mcp": { "servers": { ... } }` | `"mcpServers": { ... }` |
| **Tool naming** | `<server>_<tool>` or custom `toolPrefix` | Canonical `mcp__<server>__<tool>` via `createMcpToolName` (sanitized to `[A-Za-z0-9_-]`, names >64 chars or colliding hashed to `..._<hash>`) |
| **Tool exposure** | All tools declared directly to model | Migration sets explicit `direct`; native Pi otherwise defaults to `codemode` |
| **Agent allowlists** | Listed custom aliases in `tools: [...]` | pi-base Markdown Agent guard checks ordinary-tool execution using official names; an empty list still permits conditional runtime injection of `task` / Goal tools. This is not a generic SDK guarantee |
| **Process model** | Process-wide `McpHub` shared across root and subagents via lease counters | Independent per-session connections created on `session_start` and disposed with session |
| **SDK child sessions** | Inherited shared parent Hub | `pi-base` Subagents load MCP only (`createMcpExtension()`) using direct MCP per session; generic Pi SDK loads extra extensions explicitly |
| **Transports** | `stdio`, `streamable-http`, `sse`, `websocket` | `stdio` and `streamable-http`. Legacy `sse` and WebSocket (`websocket`/`ws`) are **rejected** |
| **Timeouts** | Milliseconds (`startupTimeoutMs`, `callTimeoutMs`) | Request timeout in seconds (`Math.ceil(ms / 1000)`); no equivalent startup timeout setting |
| **Management** | `/mcp-status` command, footer server count | `/mcp` interactive TUI, `pi mcp` CLI suite (`add`, `remove`, `list`, `login`, `logout`) |
| **Environment variables** | Whole-value `$VAR` or `${VAR}` | `${NAME}` or command execution `!command` |

## Migration Script: `scripts/migrate-mcp.mjs`

A dedicated migration script is provided to automate configuration conversion and tool reference remapping. The script is an offline tool that performs no server connections or secret expansion.

### CLI Syntax

The script is not executable; run it with `node`:

```bash
node scripts/migrate-mcp.mjs --config <pi-base.json> [--tool-map <input.json>] [--references <path>]... [--apply]
```

### Options and Parameters

- `--config <path>` (required): Path to the source `pi-base.json` file.
- `--apply` (optional): Default behavior is **dry-run**. Without `--apply`, the script only validates input, builds the migration plan, and prints summary counts (affected files count, explicit aliases count) and warnings. It **never prints diffs or configuration/secret values** (all configuration contents and secrets are strictly redacted). Passing `--apply` writes changes to disk.
- `--tool-map <path>` (optional): Path to a user-supplied **input** JSON file containing an explicit mapping of legacy aliases to official names (`{ "<old_alias>": "mcp__<server>__<tool>" }`). The script **never generates or writes this file**. Because legacy aliases or custom/empty `toolPrefix` cannot be automatically discovered offline, the user must discover tool names outside the script (e.g. via server documentation or running the server) and supply this input map.
- `--references <path>` (optional, repeatable): Path to a dependent file referencing tool names. Each occurrence accepts exactly one path and can be repeated (`--references file1.json --references file2.md`). **Accepts only regular, non-symlink `.json` and `.md` files**:
  - In `.json` files: Performs exact key renames in `permission` and `render` (`collapsedToolResultLines`, `collapsedToolResultMaxChars`) blocks. Wildcard tool patterns in rules (other than global `*`) are rejected and require manual migration.
  - In `.md` files: Only simple YAML tools lists in frontmatter (inline `tools: [a, b]` or block `tools:\n  - a`) and explicit word tokens are updated. Unsupported YAML syntax or ambiguous matches are rejected with an error.

### Safety and Processing Rules

1. **Private backups**: When `--apply` is specified, the script creates backup files named `<target>.mcp-migration-<UUID>.bak` with mode `0600` beside each affected file before making any changes. These backups are retained upon completion.
2. **Sibling `mcp.json`**: The script generates or merges with `mcp.json` in the same directory as `--config`.
3. **Automatic `exposure: "direct"`**: Every converted server entry is given `"exposure": "direct"` by the script to ensure existing agents expecting directly declared tools retain access.
4. **Preservation of literal headers**: Literal headers and environment variable definitions are copied exactly as-is without modification.
5. **Timeout conversion**: Millisecond timeouts (`callTimeoutMs` or server-level timeouts) are converted to seconds using `Math.ceil(ms / 1000)`. Because Pi 0.99.1 native MCP has no startup timeout setting, `startupTimeoutMs` is omitted and a warning is emitted.
6. **Transport rejection**: Remote servers specifying `sse` or `websocket` are rejected with an error; only `streamable-http` can be migrated.
7. **Secret handling and review warning**: Migration copies literal values verbatim without automatic secret guessing or discovery. Because `$VAR` vs `${VAR}` syntax or semantics may differ between old pi-base and native Pi MCP, native environment expansion is not guaranteed to be 1:1 compatible; manual review of environment variables and headers is required before connecting.
8. **Configuration removal**: Removal of the `mcp` block from `pi-base.json` occurs **only** after the entire migration plan has successfully executed under `--apply`.
9. **Conflict and rollback policy**: Existing unrelated native fields and servers are preserved. A differing same-name server, mapping collision, or reference ambiguity aborts planning before any writes. Ordinary write failures restore committed files and remove staging files, retaining private backups. Stop active Pi sessions while applying: this is not a crash-atomic multi-file transaction; after interruption, inspect and restore backups before retrying.
10. **Explicit coverage**: Only supplied reference paths and map entries are updated. Check map completeness before `--apply`; omitted aliases are not guessed. History, session, auth, and model files are not discovered or migrated; known protected filenames and history/session directories are rejected as references.

## Manual Migration Example

### 1. Old `pi-base.json` configuration

```json
{
  "permission": {
    "git_status": "allow",
    "filesystem_read_file": "allow"
  },
  "render": {
    "collapsedToolResultLines": {
      "filesystem_read_file": 10
    }
  },
  "mcp": {
    "startupTimeoutMs": 30000,
    "callTimeoutMs": 60000,
    "servers": {
      "filesystem": {
        "type": "local",
        "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
        "cwd": "~/work/project",
        "env": {
          "ROOT": "${PROJECT_ROOT}"
        }
      },
      "docs": {
        "type": "remote",
        "transport": "streamable-http",
        "url": "https://example.com/mcp",
        "headers": {
          "Authorization": "${DOCS_TOKEN}"
        }
      }
    }
  }
}
```

### 2. User-supplied `--tool-map` input JSON

When the server `filesystem` exposed a tool named `read_file` under legacy alias `filesystem_read_file`:

```json
{
  "filesystem_read_file": "mcp__filesystem__read_file"
}
```

### 3. Migrated `mcp.json`

Created in the sibling directory (`~/.pi/agent/mcp.json` or `.pi/mcp.json`):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "cwd": "~/work/project",
      "env": {
        "ROOT": "${PROJECT_ROOT}"
      },
      "timeout": 60,
      "exposure": "direct"
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "${DOCS_TOKEN}"
      },
      "timeout": 60,
      "exposure": "direct"
    }
  }
}
```

Notice that:
- All converted servers have `"exposure": "direct"`.
- Literal headers (`"Authorization": "${DOCS_TOKEN}"`) are preserved exactly as written.

### 4. Cleaned `pi-base.json`

The `mcp` block is removed from `pi-base.json`, and exact tool references in `permission` and `render` use official names:

```json
{
  "permission": {
    "git_status": "allow",
    "mcp__filesystem__read_file": "allow"
  },
  "render": {
    "collapsedToolResultLines": {
      "mcp__filesystem__read_file": 10
    }
  }
}
```

### 5. Updating Agent Definitions (`.md`)

If an Agent explicitly declared an MCP tool in frontmatter:

**Before:**
```yaml
---
name: file-explorer
tools:
  - read
  - filesystem_read_file
---
```

**After (when using `exposure: "direct"`):**
```yaml
---
name: file-explorer
tools:
  - read
  - mcp__filesystem__read_file
---
```

For separately chosen `codemode` exposure, the pi-base Markdown Agent guard
requires both the wrapper and authorized MCP names. See [Agent policy](agents.md#tool-allowlist);
this optional setup is not applied by the migration script.

## Post-Migration Verification

1. Before connecting, review environment variables, headers, commands, and the complete alias map. Native `${NAME}` and `!command` resolution can differ from old literal values; migration does not evaluate them.
2. After review, run `pi mcp list` to check that configured servers connect and list the actual canonical tool names.
3. Start a Pi session and run `/mcp` to inspect servers, exposure modes, and tool declarations.
4. Reload runtime: Run `/reload` inside running sessions to pick up changes.
