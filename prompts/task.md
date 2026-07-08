Delegate a self-contained task to a subagent that runs autonomously in an isolated session and returns a single final report.

Usage:
- Use `task` only when the current agent has a Subagents section in the system prompt and one of those subagent types clearly fits the work.
- Set `subagent_type` to one of the agent names listed there. If none fits, do the work yourself with other tools.
- To run several subagents at once, emit multiple `task` calls in a single message — they execute concurrently.
- Give a highly detailed, self-contained `prompt` and state exactly what the subagent should return; it does not see the user's intent unless you include it.
- Say whether you want code changes or just research, and how to verify the work if possible.
- Each call starts a fresh subagent unless you pass `session_id` to resume a previous one.
- The report is returned to you but is NOT shown to the user; summarize it yourself. The result includes the `session_id` for resuming later.

Parameters:
- `subagent_type` (required)
- `description` (required): short 3-5 word task label shown in the UI
- `prompt` (required)
- `session_id` (optional)
