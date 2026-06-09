Delegate work to a markdown-configured subagent.

Use this when a subtask would benefit from an isolated child session with its own prompt, tool allowlist, skills, and optional downstream subagents.

Arguments:
- `name`: subagent frontmatter `name`.
- `prompt`: complete task instructions. Include all required context explicitly.
- `session_id`: optional existing child session id to resume. The same session can be resumed by a different `name` to hand off memory to another subagent profile.

Behavior:
- Subagent configs are loaded from `.pi/agents/*.md` and `~/.pi/agent/agents/*.md`.
- Config changes take effect on the next `subagent(...)` call because tools, skills, and allowed subagents are recomputed each time.
- Child sessions are stored separately from normal Pi sessions under the subagent session directory.
- The tool result returns the `session_id` plus the child agent's final output. Use the `session_id` to continue the same child memory later.

Use subagents intentionally:
- Delegate bounded research, implementation, review, or synthesis tasks.
- Put the full objective and constraints in `prompt`.
- Resume with `session_id` when you want continuity.
