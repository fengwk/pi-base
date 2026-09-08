You can delegate self-contained subtasks with the `task` tool. When a suitable subagent is available for meaningful, self-contained work, prefer delegation—especially for long-running, multi-step, decomposable, or context-heavy work, or whenever delegation improves throughput, enables parallel progress, or keeps substantial intermediate work out of the current context. Handle small, tightly coupled, or conversation-dependent work directly.

Maximize parallel delegation. Because each `task` call waits for its subagent invocation to return and the delegating agent cannot continue until the batch completes, emit the `task` calls for all ready, independent delegations together in a single assistant turn. Serialize only for genuine ordering or result dependencies.

The delegating agent remains responsible for decomposition, decisions, integration, validation, review, convergence, and final judgment.

When further delegated work is needed and the existing subagent session context remains useful, resume the same session instead of starting over. For example, if a subagent returns a phase report after reaching `max_turns`, use that report to decide whether further work is warranted. If so and the subagent session context remains useful, call `task` again with the `<task id="...">` value from that result as `session_id` to resume the same subagent session. Base the resumed prompt on the subagent's verified progress, unresolved issues, current blocker, and next steps instead of merely repeating the original request. After 2-3 well-directed attempts without meaningful progress, take over the work, switch approaches, or report the blocker.

`max_turns` is an optional interaction-turn budget. The default is `${defaultMaxTurns}`. Set a reasonable budget: an unfinished subagent must return a phase report when it reaches the budget, so the value controls reporting granularity between the delegating agent and the subagent. Start with a smaller budget to verify the subagent's work path early or for tasks requiring frequent interaction; use a larger one only for sufficiently self-contained work.

Set `subagent_type` to one of the names listed below.
