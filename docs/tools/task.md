<p align="center">
  🌐 <a href="task.md">English</a> · <a href="task.zh-CN.md">简体中文</a>
</p>

# `task`

[← Tool index](README.md) · [Shared architecture](../architecture.md)

## Purpose

Creates or resumes a Subagent session and hands `prompt` to the designated Markdown Agent for execution.

## Injection conditions

`task` is not always visible. The current Agent must:

1. Declare a non-empty `subagents` allowlist.
2. Have a current session depth below `subagent.maxDepth`.

The injection logic lives in [`src/agent-support.ts`](../../src/agent-support.ts), and the tool implementation in [`src/subagent/task-tool.ts`](../../src/subagent/task-tool.ts).

## Parameters

| Parameter | Required | Default | Description |
|------|------|------|------|
| `subagent_type` | yes | — | Agent name in the allowlist |
| `prompt` | yes | — | Task instructions handed to the Subagent for execution |
| `maxTurns` | no | configured value, default 50 | Soft-stop turn budget for this invocation |
| `session_id` | no | — | Resumes an existing Subagent session |

The schema is built by [`src/subagent/schema.ts`](../../src/subagent/schema.ts) from the default `maxTurns` of the current workspace.

## Execution chain

```text
validate required args
  -> Agent exists
  -> in current allowlist
  -> resume session not running
  -> reserve parent/root concurrency slots
  -> create/resume AgentSession
  -> write Agent/depth/root entries
  -> register with SubagentRegistry
  -> run + progress listener
  -> completed/error/aborted result
```

Agent, allowlist, and resume-state validation completes before the session is created and concurrency slots are reserved.

## Session creation

The factory lives in [`src/subagent/runner.ts`](../../src/subagent/runner.ts):

- Computes the Subagent session directory from cwd.
- Creates or resumes the Pi AgentSession.
- Binds persistent extensions.
- Writes the current Agent state.
- Writes the depth and root session id.
- Checks that the child and parent load the same `pi-base` module instance.

Fails fast when the extension is only loaded via a temporary `pi -e` flag of the parent session and the child cannot inherit the same extension.

## Resume

When `session_id` is passed:

- A session that is already running cannot be resumed again.
- Concurrent resumes of the same session are prevented via process-level reservations.
- The Agent catalog is reloaded before every invocation; resume uses the passed `subagent_type` and the latest Agent config on disk.

## Concurrency

Two levels of concurrency limits:

- `maxConcurrency`: direct children of a single parent.
- `maxTotalConcurrency`: the entire root delegation tree.

Concurrency slots are reserved before creation; the pending reservation is released once the Subagent is registered with the registry, and the reservation counts toward the limits in the meantime.

## Depth

Root depth is 1. Children are created with:

```text
childDepth = parentDepth + 1
```

Once `maxDepth` is reached, the Agent no longer receives `task`.

## maxTurns

`maxTurns` is a soft stop:

- When the budget is reached, a hint is sent to the child asking it to return a phase report if unfinished.
- Tools that are currently executing are not forcibly terminated.
- If the child continues tool-driven, a reminder is sent every 5 additional valid turns.

After the soft stop is reached, the same child session can be resumed with that `session_id` to continue execution.

## Idle timeout and abort

- `idleTimeoutMs` only triggers when the session has no assistant/session activity.
- `idleTimeoutMs` does not trigger while a tool call is in progress.
- Parent cancellation propagates to the current child and its delegation subtree.
- Running state is stored in the process-level `SubagentRegistry`, shared by the UI widget and `/subagent`.

## Permission

When a headless child encounters `ask`, the request is forwarded to the permission host of the root UI. If the root UI does not exist or the host is stale, the request fails without an implicit allow.

## Result

The tool returns:

```xml
<task id="session-id" state="completed">
<task_result>...</task_result>
</task>
```

Non-`completed` states set `isError: true`. `details.result` keeps the structured session id, state, and output.

## UI

- The root UI widget shows the running parent/child tree and recent activity.
- `/subagent` opens the session picker.
- `/subagent <id-or-prefix>` reads the transcript read-only.

## Related tests

- [`tests/subagent-task-tool.test.ts`](../../tests/subagent-task-tool.test.ts)
- [`tests/subagent-runner.test.ts`](../../tests/subagent-runner.test.ts)
- [`tests/subagent-integration.test.ts`](../../tests/subagent-integration.test.ts)
- [`tests/subagent-task-injection.test.ts`](../../tests/subagent-task-injection.test.ts)
- [`tests/subagent-permission-relay.test.ts`](../../tests/subagent-permission-relay.test.ts)
- [`tests/subagent-widget.test.ts`](../../tests/subagent-widget.test.ts)
- [`tests/subagent-command.test.ts`](../../tests/subagent-command.test.ts)
