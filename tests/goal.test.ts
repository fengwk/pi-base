import { describe, expect, it } from "vitest";
import { filterGoalContextMessages, registerGoalSupport } from "../src/goal/index.js";
import { GOAL_STATE_ENTRY_TYPE, tokenDeltaFromUsage, type GoalState } from "../src/goal/state.js";
import { createToolRegistry } from "./helpers.js";

function assistantMessage(
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted",
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } = {},
) {
  return {
    role: "assistant" as const,
    content: [],
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    stopReason,
    usage: {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
}

function latestGoal(registry: ReturnType<typeof createToolRegistry>): GoalState | null {
  const entry = registry.getEntries()
    .filter((item) => item.customType === GOAL_STATE_ENTRY_TYPE)
    .at(-1);
  return entry?.data?.goal ?? null;
}

async function finishAgentRun(
  registry: ReturnType<typeof createToolRegistry>,
  message = assistantMessage("stop"),
): Promise<void> {
  await registry.emit("agent_start", { type: "agent_start" });
  await registry.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  await registry.emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });
  await registry.emit("agent_end", { type: "agent_end", messages: [message] });
  await registry.emit("agent_settled", { type: "agent_settled" });
}

describe("goal support", () => {
  it("steers a user-set goal or starts it immediately while idle", async () => {
    // Intent: one goal-set message gives streaming and idle users equivalent behavior: Pi steers
    // a running agent, or starts a new goal-set turn when no agent is running.
    const registry = createToolRegistry();
    registerGoalSupport(registry.pi as never);

    await registry.runCommand("goal", "Ship the verified feature");
    expect(registry.getMessageSends()).toHaveLength(1);
    expect(registry.getMessageSends()[0]).toMatchObject({
      message: { details: { kind: "goal_set" } },
      options: { triggerTurn: true, deliverAs: "steer" },
    });

    await finishAgentRun(registry, assistantMessage("stop", {
      input: 10,
      output: 5,
      cacheRead: 1_000,
      cacheWrite: 2,
      totalTokens: 1_017,
    }));

    expect(registry.getMessageSends()).toHaveLength(2);
    expect(registry.getMessageSends()[1]).toMatchObject({
      message: { details: { kind: "continuation" } },
      options: { triggerTurn: true },
    });
    expect(latestGoal(registry)).toMatchObject({ status: "active", tokensUsed: 17 });
  });

  it("steers a user-set goal without scheduling continuation during an active run", async () => {
    // Intent: the active agent receives the new objective immediately instead of waiting for a
    // future continuation, while no duplicate triggerTurn is launched mid-run.
    const registry = createToolRegistry();
    registerGoalSupport(registry.pi as never);

    await registry.runCommand("goal", "Redirect the active work", { isIdle: () => false });

    expect(registry.getMessageSends()).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ details: expect.objectContaining({ kind: "goal_set" }) }),
        options: { triggerTurn: true, deliverAs: "steer" },
      }),
    ]);
  });

  it("pauses on an aborted assistant and does not continue after agent_settled", async () => {
    // Intent: an Esc interruption is persisted as paused before the idle continuation decision,
    // proving that no queued goal message can restart the loop.
    const registry = createToolRegistry();
    registerGoalSupport(registry.pi as never);
    await registry.runCommand("goal", "Keep working until verified");
    const sendsBeforeAbort = registry.getMessageSends().length;

    await finishAgentRun(registry, assistantMessage("aborted"));

    expect(latestGoal(registry)?.status).toBe("paused");
    expect(registry.getMessageSends()).toHaveLength(sendsBeforeAbort);
    expect(registry.getNotifications().at(-1)?.message).toContain("interrupted");
  });

  it("starts budget accounting with the first turn that begins under the new goal", async () => {
    // Intent: create_goal may run halfway through an ordinary turn. That pre-goal turn must not
    // consume a budget intended for subsequent autonomous goal work.
    const registry = createToolRegistry();
    registerGoalSupport(registry.pi as never);
    await registry.emit("agent_start", { type: "agent_start" });
    await registry.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });

    await registry.getTool("create_goal").execute(
      "call",
      { objective: "Start accounting after this turn", tokenBudget: 100 },
      undefined,
      undefined,
      { isIdle: () => false },
    );
    expect(registry.getMessageSends()).toHaveLength(0);
    const creationTurn = assistantMessage("stop", { input: 60, output: 40 });
    await registry.emit("turn_end", { type: "turn_end", turnIndex: 0, message: creationTurn, toolResults: [] });
    await registry.emit("agent_end", { type: "agent_end", messages: [creationTurn] });
    await registry.emit("agent_settled", { type: "agent_settled" });

    expect(latestGoal(registry)).toMatchObject({ status: "active", tokensUsed: 0 });
    expect(registry.getMessageSends().at(-1)?.options).toEqual({ triggerTurn: true });
  });

  it("uses non-cached input plus output for the budget and steers one wrap-up turn", async () => {
    // Intent: cached context must not consume the goal budget repeatedly; the crossing turn queues
    // one immediate steering message rather than a post-agent follow-up.
    const registry = createToolRegistry();
    registerGoalSupport(registry.pi as never);
    await registry.runCommand("goal", "--tokens 30 Finish within budget");
    await registry.emit("agent_start", { type: "agent_start" });

    const first = assistantMessage("toolUse", { input: 10, output: 5, cacheRead: 2_000 });
    await registry.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
    await registry.emit("turn_end", { type: "turn_end", turnIndex: 0, message: first, toolResults: [] });
    expect(latestGoal(registry)).toMatchObject({ status: "active", tokensUsed: 15 });

    const second = assistantMessage("stop", { input: 10, output: 10, cacheRead: 2_000 });
    await registry.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
    await registry.emit("turn_end", { type: "turn_end", turnIndex: 1, message: second, toolResults: [] });
    await registry.emit("agent_end", { type: "agent_end", messages: [first, second] });
    await registry.emit("agent_settled", { type: "agent_settled" });

    expect(latestGoal(registry)).toMatchObject({ status: "budget_limited", tokensUsed: 35 });
    const budgetSend = registry.getMessageSends().find((send) => send.message.details?.kind === "budget_limit");
    expect(budgetSend?.options).toEqual({ deliverAs: "steer" });
    expect(registry.getMessageSends().filter((send) => send.message.details?.kind === "continuation")).toHaveLength(0);
  });

  it("waits for the final settled result before blocking an errored goal", async () => {
    // Intent: overflow recovery can emit an intermediate error/agent_end; only agent_settled proves
    // retries are exhausted, so a successful retry must keep the goal active.
    const registry = createToolRegistry();
    registerGoalSupport(registry.pi as never);
    await registry.runCommand("goal", "Recover and continue");

    const failed = assistantMessage("error");
    await registry.emit("agent_start", { type: "agent_start" });
    await registry.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
    await registry.emit("turn_end", { type: "turn_end", turnIndex: 0, message: failed, toolResults: [] });
    await registry.emit("agent_end", { type: "agent_end", messages: [failed] });

    const recovered = assistantMessage("stop");
    await registry.emit("agent_start", { type: "agent_start" });
    await registry.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
    await registry.emit("turn_end", { type: "turn_end", turnIndex: 0, message: recovered, toolResults: [] });
    await registry.emit("agent_end", { type: "agent_end", messages: [recovered] });
    await registry.emit("agent_settled", { type: "agent_settled" });

    expect(latestGoal(registry)?.status).toBe("active");
    expect(registry.getMessageSends().at(-1)?.message.details?.kind).toBe("continuation");
  });

  it("filters aborted/error assistants before request estimation and keeps only current goal control", async () => {
    // Intent: the filtered array matches provider replay semantics, covering the compacted-session
    // case where a huge aborted tool call otherwise clamps the next output budget to 1/16 tokens.
    const registry = createToolRegistry();
    const handle = registerGoalSupport(registry.pi as never);
    await registry.runCommand("goal", "Keep the context clean");
    const currentControl = registry.getMessages().at(-1);
    const goal = handle.getGoal();
    expect(goal).not.toBeNull();

    const olderControl = { ...currentControl, timestamp: 1 };
    const latestControl = { ...currentControl, timestamp: 2 };
    const aborted = {
      ...assistantMessage("aborted"),
      content: [{ type: "toolCall", id: "call", name: "apply_patch", arguments: { patchText: "x".repeat(100_000) } }],
    };
    const normal = assistantMessage("stop");
    const messages = [
      { role: "user", content: "start", timestamp: 0 },
      olderControl,
      aborted,
      latestControl,
      normal,
    ];

    const filtered = filterGoalContextMessages(messages, goal, null);
    expect(filtered).toEqual([messages[0], latestControl, normal]);
    const hooked = await registry.emit("context", { type: "context", messages });
    expect(hooked.messages).toEqual([messages[0], latestControl, normal]);
    expect(filterGoalContextMessages(messages, { ...goal!, status: "paused" }, null)).toEqual([messages[0], normal]);
  });

  it("ignores custom state entries owned by other extensions", async () => {
    // Intent: goal state has one explicit entry type; unrelated historical extension state cannot
    // activate a goal or cause an error when a session is resumed.
    const registry = createToolRegistry();
    registry.pi.appendEntry("other-extension-state", { goal: { status: "active" } });
    const handle = registerGoalSupport(registry.pi as never);

    await registry.emit("session_start", { type: "session_start", reason: "resume" });

    expect(handle.getGoal()).toBeNull();
    expect(registry.getMessageSends()).toHaveLength(0);
  });

  it("removes goal tools and does not restore goal state in unsupported sessions", async () => {
    // Intent: pi-base loads into headless subagent sessions too, but goal ownership and its
    // autonomous continuation loop must remain exclusively with the primary session.
    const registry = createToolRegistry();
    registry.pi.setActiveTools(["read", "create_goal", "get_goal", "update_goal"]);
    const handle = registerGoalSupport(registry.pi as never, { isSessionSupported: () => false });

    await registry.emit("session_start", { type: "session_start", reason: "startup" });

    expect(registry.getActiveTools()).toEqual(["read"]);
    expect(handle.getInjectedToolNames(false)).toEqual([]);
    expect(latestGoal(registry)).toBeNull();
    expect(registry.getMessageSends()).toHaveLength(0);
  });

  it("injects a visible full goal contract into every user-triggered run", async () => {
    // Intent: automatic and user-triggered turns use the same custom-message mechanism, so users
    // can expand the exact durable objective and evidence audit that reaches the model.
    const registry = createToolRegistry();
    registerGoalSupport(registry.pi as never);
    await registry.runCommand("goal", "Verify every named artifact");

    const result = await registry.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "continue",
      systemPrompt: "base prompt",
      systemPromptOptions: {},
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      customType: "pi-base-goal-control",
      display: true,
    });
    expect(result.messages[0].content).toContain("Verify every named artifact");
    expect(result.messages[0].content).toContain("Completion audit:");
    expect(registry.getMessages()[0]?.content).toContain("Verify every named artifact");
    expect(registry.getMessages()[0]?.content).toContain("Blocked audit:");
  });

  it("computes the Codex-style token delta directly", () => {
    expect(tokenDeltaFromUsage({ input: 40, output: 10, cacheRead: 500, cacheWrite: 5, totalTokens: 555 })).toBe(55);
  });
});
