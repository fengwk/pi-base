Delegate a self-contained task to a subagent that runs autonomously in an isolated session and returns a single final report.

Usage:
- Use `task` only when the system prompt includes an `<available_subagents>` section and one of the listed subagent types fits the work.
- Set `subagent_type` to one of the names in `<available_subagents>`. If none fits, handle the work directly.
- A new `task` starts in a fresh session without access to the current conversation. Its `prompt` must be self-contained, specific, and actionable.
- Include the objective, necessary context, relevant scope and boundaries, important constraints, completion criteria, expected deliverable, required output format, and verification instructions when applicable.
- State whether the subagent should modify files, perform read-only research, execute commands, run tests, or verify results.
- When work can be decomposed into independent parts such as `X + Y + Z`, split it into multiple `task` calls and emit them in the same message so they run concurrently.
- When `session_id` is provided, the subagent resumes that session with its existing context. Provide the new direction, additional context, or updated objective based on its progress and current blocker. Do not merely repeat the previous prompt.
- Resume a session only while its existing context remains useful. Start a new task when the objective or scope has materially changed.
- The subagent returns its report to the main agent, not directly to the user. Review and integrate the result yourself. The returned envelope includes a resumable identifier in the form `<task id="...">`.

Parameters:
- `subagent_type` (required): A subagent type listed in `<available_subagents>`.
- `prompt` (required): Complete instructions for a new task or updated direction for a resumed task.
- `maxTurns` (optional): A positive interaction-turn budget. The default is `${defaultMaxTurns}`. An unfinished child must return a phase report at the budget; use a smaller value early to verify its path or when frequent parent-child interaction is needed.
- `session_id` (optional): The `<task id="...">` value of the session to resume.
