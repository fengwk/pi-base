<p align="center">
  🌐 <a href="agents.md">English</a> · <a href="agents.zh-CN.md">简体中文</a>
</p>

# Markdown Agents

[Documentation home](README.md) · [Architecture](architecture.md) · [Configuration reference](configuration.md)

`pi-base` can load named Agents from Markdown files, pinning the system prompt, model, thinking level, tools, skills, and delegable Subagents for different tasks.

Agent examples are in [`examples/agents`](../examples/agents/).

## File locations

Default directory:

```text
~/.pi/agent/agents/**/*.md
```

The directory is scanned recursively for `.md` files. The Agent catalog is reloaded at session startup, whenever `/agent` runs, and before every `task` invocation.

The built-in `default` Agent does not come from this directory; it uses `~/.pi/agent/SYSTEM.md` and Pi's default model settings. Custom Agents cannot use the reserved name `default`.

## Minimal example

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

The Markdown body after the Frontmatter serves as the Agent's custom prompt. When the body is empty, the default system prompt continues to be used.

## Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Agent name; when omitted, the file name without `.md` is used |
| `description` | No | Summary shown in the `/agent` selector and the Subagent list |
| `model` | No | `provider/model` format; when the model is not found, the current session model is kept and a warning is issued |
| `thinkingLevel` | No | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `tools` | No | Array of tool names available to the current Agent |
| `skills` | No | Array of skill names visible to the model |
| `subagents` | No | Array of Agent names allowed for delegation via `task` |

Unknown fields invalidate the entire Agent file. String arrays are deduplicated; empty strings or non-array values invalidate the file.

## Tool allowlist

- `tools` omitted: inherit the current default tool policy.
- Explicit array: only tools that are currently registered and match are kept.
- Empty array: no ordinary tools are provided.
- File modification tools are projected against the current model, but the explicit allowlist is never expanded.
- Dynamic tools such as MCP can be written into the allowlist in advance; availability is validated after the first connection succeeds.

Tools that are currently unavailable produce a warning, but their names are not removed from the allowlist; they can still be activated after the tool is later registered or an MCP reconnection succeeds. When the first MCP connection fails, the tool is marked unavailable for the current startup phase and a warning is produced.

## Skill allowlist

- `skills` omitted: use the skills currently available for the model to call.
- Explicit array: only skills with matching names are injected.
- Empty array: no skills are injected.
- Skills marked as forbidden for model calls do not enter the system prompt.
- When `read` is not in the current tool set, no skills are injected into the system prompt.

Skills tell the model via prompt when to load the corresponding `SKILL.md`; they are not Pi tools.

## Subagent allowlist

`subagents` can only reference already-loaded Agents. Unknown names are ignored and produce a catalog warning.

`task` is injected only when all of the following conditions are met:

1. The current Agent's `subagents` is non-empty.
2. The current session depth is less than `subagent.maxDepth`.
3. The `task` tool is available in the current session.

For concurrency, resumption, `maxTurns`, and permission relay, see [`task`](tools/task.md).

## Selecting and switching

Agent selection priority at session startup:

```text
Agent persisted in the current session
  > --agent
  > pi-base.json defaultAgent
  > built-in default
```

The first entry only exists in sessions that resumed or inherited Agent state; a fresh session starts evaluating from `--agent`.

Selection and switching commands:

```bash
pi --agent reviewer
```

```text
/agent reviewer
/agent default
/agent
```

`/agent` without arguments opens the selector in the interactive UI. When resuming an existing session, the persisted Agent takes precedence over `--agent`; the resumption preserves the session's current model and thinking level.

## Diagnostics

- Duplicate Agent names: keep the first loaded definition and ignore subsequent files.
- Invalid Frontmatter: ignore the file and show a warning.
- Unknown tool: keep the allowlist name and warn, allowing later dynamic registration.
- Unknown skill: stay hidden and warn.
- Unknown subagent: remove from the allowlist and warn.
- Model missing or cannot be activated: keep the current session model.

## Related implementation and tests

- [`src/agent-support.ts`](../src/agent-support.ts)
- [`tests/agent-support.test.ts`](../tests/agent-support.test.ts)
- [`tests/subagent-task-injection.test.ts`](../tests/subagent-task-injection.test.ts)
