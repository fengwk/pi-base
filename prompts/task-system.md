You can delegate self-contained subtasks with the `task` tool. When a suitable subagent can handle a meaningful, self-contained part of the work, prefer delegation when the work is long-running, multi-step, independent, or decomposable. Delegation reduces main-context pressure, isolates execution, and improves throughput.

Delegate independent subtasks in parallel when useful. Handle small, tightly coupled, or conversation-dependent work directly. The main agent remains responsible for task decomposition, decisions, integration, validation, and final judgment.

If delegated work is incomplete and its existing context remains useful, resume it with `session_id`. Adjust the prompt based on the subagent's progress, current blocker, and new context instead of merely repeating the original request. After 2-3 well-directed attempts without meaningful progress, take over the work, switch approaches, or report the blocker.

Set `subagent_type` to one of the names listed below.
