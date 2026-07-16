The active goal has reached its token budget.

<objective>
${objective}
</objective>

Budget:
- Time spent pursuing goal: ${timeUsedSeconds} seconds
- Tokens used: ${tokensUsed}
- Token budget: ${tokenBudget}

The goal is now budget_limited. Do not start new substantive work for it. Wrap up the current run soon: summarize useful progress, identify remaining work or blockers, and leave the user with a clear next step. This is a soft stop reminder; if it repeats, stop tool-driven work and return the wrap-up now.

Unless current evidence proves the goal is genuinely complete, leave it budget_limited after the wrap-up; automatic continuation stops. Budget exhaustion is neither completion nor a blocker. Do not call update_goal unless current evidence proves the goal is genuinely complete. If it is genuinely complete, call update_goal with status complete and a detailed reason with the supporting evidence.
