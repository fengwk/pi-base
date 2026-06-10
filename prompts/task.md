Delegate a subtask to a subagent in an isolated session.

Use this when a subtask would benefit from independent execution in a separate session and should be completed by a suitable subagent.

Advantages:
- Efficiency: independent subtasks can be delegated to multiple subagents in parallel.
- Isolation: each subagent runs in a separate session and focuses only on the prompt you provide.
- Context hygiene: the subagent session absorbs long execution traces and returns only the information you asked for.
- Specialization: available subagents are presented as a structured list of `name` and `description`; choose the subagent whose description best matches the subtask.

Arguments:
- `subagent`: subagent name.
- `prompt`: complete subtask instructions. Include all required context, the exact subtask goal, constraints, expected output format, and any verification requirements.
- `session_id`: optional existing subagent session id to resume. Use this to continue the same session with a more specific follow-up prompt. By default, resume with the same subagent.

Behavior:
- The tool result returns the current subagent name, the subagent `session_id`, and the subagent's final report.
- Subagents cannot invoke other subagents. You are responsible for coordinating all delegation from the parent session.
- Different subagent sessions cannot communicate with each other directly. If one subagent's findings should inform another subagent, you must pass the relevant context yourself in a later `prompt`.

Best practices:
1. On the first delegation, include all relevant context explicitly. A subagent does not share your current session memory.
2. You cannot change the prompt mid-run, so specify the subtask goal, execution boundaries, report format, and verification expectations up front. If the subtask has side effects such as code changes or command execution, ask the subagent to report the actions, outcomes, and validation results clearly.
3. If the subagent stops early or returns an incomplete report, call `task(...)` again with the same `session_id` and a more specific follow-up prompt.
4. Treat subagent output as fallible. Review important claims, code changes, and command results, and verify them before moving on.
5. When a larger task can be split into independent parts, delegate multiple subtasks in parallel, then integrate the reports, verify the results, and decide the next step.
6. Subagents do not coordinate with each other automatically. If you want one subagent to build on another subagent's findings, summarize the relevant results and inject them into the next prompt yourself.
7. Use subagents to absorb long-running or noisy execution output. Ask them to return only the specific structured information you need, such as pass/fail status, key error locations, changed files, validation results, and concise conclusions.