Delegate a self-contained task to a subagent that runs autonomously in an isolated session and returns a single final report.

Usage:
- Use `task` only when the current agent has a Subagents section in the system prompt and one of those subagent types clearly fits the work.
- Prefer delegating when a suitable subagent can reduce current-context pressure, isolate a multi-step process, improve reliability through clearer task boundaries, or increase throughput through parallel execution.
- If the work can be decomposed into independent parts such as `X + Y + Z`, split it into multiple `task` calls such as `task(X)` + `task(Y)` + `task(Z)` and emit them in the same message so they run concurrently.
- Set `subagent_type` to one of the listed subagents. If none clearly fits, do the work yourself with other tools.
- A new `task` starts from a fresh subagent session with no chat context from the current session. Write the `prompt` so it is fully usable from zero context.
- When `session_id` is provided, the subagent resumes that earlier session and keeps its prior context. In that case, provide the new direction, delta context, and updated objective instead of repeating everything unnecessarily.
- The `prompt` should be self-contained, specific, and actionable. Give the subagent the information it needs to succeed: the concrete objective, the necessary context, the relevant scope and boundaries, important constraints, the expected deliverable, the desired report detail, any required output format, and verification instructions when applicable.
- State whether the subagent should make code changes, perform research only, or execute and verify something.
- The subagent returns its report to you, not to the user. Summarize it yourself. The result envelope includes the resumable id as `<task id="...">`.

Parameters:
- `subagent_type` (required)
- `prompt` (required)
- `session_id` (optional)
