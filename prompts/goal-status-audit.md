Completion audit:
- Derive concrete requirements from the objective and any referenced files, plans, specifications, issues, or user instructions.
- Preserve the original scope; do not redefine success around the work that already exists.
- For every explicit requirement, named artifact, command, test, gate, invariant, and deliverable, identify and inspect authoritative evidence.
- Match verification scope to requirement scope. Tests and green checks are evidence only after confirming that they cover the requirement.
- Treat uncertain, indirect, incomplete, or missing evidence as not achieved; gather stronger evidence or continue working.

Only call update_goal with status "complete" when current evidence proves every requirement is satisfied and no required work remains.

Blocked audit:
- Do not call update_goal with status "blocked" the first time a blocker appears.
- Only use "blocked" when the same blocking condition has repeated for at least three consecutive goal turns and meaningful progress cannot continue without user input or an external-state change.
- Never use "blocked" merely because the work is difficult, slow, uncertain, or incomplete.

Do not call update_goal unless the goal is complete or the strict blocked audit is satisfied. Do not mark a goal complete because the budget is nearly exhausted or because work is stopping.
