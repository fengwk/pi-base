<p align="center">
  🌐 <a href="goal-tools.md">English</a> · <a href="goal-tools.zh-CN.md">简体中文</a>
</p>

# Goal tools

[← Tool index](README.md) · [Shared architecture](../architecture.md)

## Purpose

Goal mode provides the root session with persistent, pausable, resumable long-term goals, and lets the model read and update state through three tools.

## Tools

| Tool | Parameters | Purpose |
|------|------|------|
| `create_goal` | `objective`, optional `tokenBudget` | Create or replace the Goal |
| `get_goal` | none | Read the current Goal and remaining budget |
| `update_goal` | `status`, `reason` | Mark `complete` or `blocked` |

The implementation lives in [`src/goal/index.ts`](../../src/goal/index.ts), and the state model in [`src/goal/state.ts`](../../src/goal/state.ts).

## Injection policy

- The Goal belongs only to the main session.
- Subagents do not restore the Goal and do not get Goal tools.
- The main session's implicit/default Agent gets `create_goal` injected.
- Agents with an explicit tool allowlist get the tool only when `create_goal` is declared in `tools`; the `/goal` command can also create a Goal.
- `get_goal` and `update_goal` are injected once the Goal is active.

## States

```text
active
paused
blocked
budget_limited
complete
```

The persisted `GoalState` contains:

- `id`
- `objective`
- `status`
- `tokenBudget`
- `tokensUsed`
- `timeUsedSeconds`
- `createdAt`
- `updatedAt`

The snapshot uses the session custom entry `pi-base-goal-state`.

## `create_goal`

Schema:

- `objective`: non-empty objective text.
- `tokenBudget`: optional positive number.

The tool description requires passing `tokenBudget` only when the user explicitly specifies a budget.

Execution:

1. Trim the objective.
2. Normalize the budget.
3. Create a version 1 GoalState.
4. Replace the existing Goal.
5. Persist the snapshot.

`create_goal` writes the GoalState; the visible goal-set control message is created by the `/goal` command.

## `get_goal`

No parameters; returns:

- The current Goal.
- Formatted status.
- Remaining token information.

When there is no Goal, it returns an empty-state description, not a tool error.

## `update_goal`

Parameters:

```text
status: complete | blocked
reason: non-empty evidence/rationale
```

Restrictions:

- Fails when there is no Goal.
- The Goal must be active; budget wrap-up is a special exception.
- A budget-limited wrap-up can only be marked complete.
- `reason` must be non-empty.

The tool persists the status, but `reason` is only used as the audit note for the current call and is not written to GoalState.

## The `/goal` command

```text
/goal [--tokens 50k] <objective>
/goal status
/goal edit <objective>
/goal pause
/goal resume
/goal clear
/goal statusbar [on|off]
```

The token budget supports the `k` / `m` suffixes.

## Budget

Every main session turn counts:

```text
input + output + cacheWrite
```

`cacheRead` is not counted again. When the budget is reached, the state becomes `budget_limited`.

The budget does not force-abort the current run:

- Sends soft-stop wrap-up guidance.
- Stops automatic continuation once settled.
- Re-sends the prompt every additional 5 tool-driven turns.

## Auto-continuation

After `agent_settled`, an active Goal is checked:

- Complete/blocked: stop.
- Aborted: switch to paused.
- Context overflow or failed overflow recovery: switch to paused.
- Other errors: switch to blocked.
- Status active: inject a continuation.

After `Esc` pauses, `/goal resume` is required to continue. Reload changes an active Goal to paused; `/goal resume` must then be run to continue.

## Context filtering

Before a provider request, the following are filtered:

- Old Goal control messages.
- Aborted/error assistant messages.
- Continuations superseded by a new state.

Only the currently valid Goal guidance is kept.

## Related tests

- [`tests/goal.test.ts`](../../tests/goal.test.ts)
- [`tests/goal-state.test.ts`](../../tests/goal-state.test.ts)
- [`tests/index-lifecycle.test.ts`](../../tests/index-lifecycle.test.ts)
