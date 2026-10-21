import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION,
  type AgentSession, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, getSystemMessageText, type AssistantMessage, type TranscriptContext,
} from "@earendil-works/pi-ai";
import piBaseExtension from "../index.js";
import { AGENT_STATE_ENTRY } from "../src/agent-support.js";
import { GOAL_STATE_ENTRY_TYPE } from "../src/goal/state.js";
import { reloadRuntimePiBaseSettings } from "../src/runtime-settings.js";

// Real offline AgentSession regressions for Pi 1.2.0 goal starting-message compatibility. A local
// provider stream makes every run deterministic without network, credentials, or private Pi APIs.

let root: string | undefined;
let session: AgentSession | undefined;

interface StartRecord {
  messageType: string;
  customKind: string | undefined;
  idle: boolean;
}

interface Harness {
  requests: TranscriptContext[];
  starts: StartRecord[];
  filteredControls: Array<Array<string | undefined>>;
  errors: unknown[];
  cwd: string;
}

afterEach(async () => {
  try {
    if (session) {
      try {
        await session.abort();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session.dispose();
      }
    }
  } finally {
    session = undefined;
    reloadRuntimePiBaseSettings();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

function customKinds(history: readonly unknown[]): Array<string | undefined> {
  return history
    .filter((message) => (message as { role?: string }).role === "custom")
    .map((message) => (message as { details?: { kind?: string } }).details?.kind);
}

function historyKinds(): Array<string | undefined> {
  return customKinds(session!.messages);
}

function contextText(context: TranscriptContext): string {
  return JSON.stringify(context);
}

function systemText(context: TranscriptContext): string {
  return context.messages
    .filter((message) => message.role === "system")
    .map(getSystemMessageText)
    .join("\n");
}

function completedGoalStatus(): string | undefined {
  const entry = session!.sessionManager.getEntries()
    .filter((item) => (item as { customType?: string }).customType === GOAL_STATE_ENTRY_TYPE)
    .at(-1) as { data?: { goal?: { status?: string } } } | undefined;
  return entry?.data?.goal?.status;
}

async function setup(options: {
  seedActiveGoal?: boolean;
  completeAt: (requestCount: number) => boolean;
}): Promise<Harness> {
  expect(VERSION).toBe("1.2.0");
  root = await mkdtemp(join(tmpdir(), "pi-goal-runtime-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(join(agentDir, "agents"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_BASE_GLOBAL_SETTINGS_PATH", join(agentDir, "pi-base.json"));
  await writeFile(join(agentDir, "pi-base.json"), JSON.stringify({
    yolo: true, notify: { agentEnd: false, permissionAsked: false },
  }));
  await writeFile(join(agentDir, "agents", "goal-fixture.md"),
    "---\nname: goal-fixture\n---\nGoal fixture system instruction.\n");

  const requests: TranscriptContext[] = [];
  const starts: StartRecord[] = [];
  const filteredControls: Array<Array<string | undefined>> = [];
  const errors: unknown[] = [];
  const probe: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", (event, ctx) => {
      starts.push({
        messageType: event.messageType,
        customKind: event.messageType === "custom"
          ? (event.message.details as { kind?: string } | undefined)?.kind
          : undefined,
        idle: ctx.isIdle(),
      });
    });
    // Registered after pi-base, so this observes the goal extension's filtered context.
    pi.on("context", (event) => {
      filteredControls.push(customKinds(event.messages));
    });
  };

  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: true, allowModelNetwork: false,
  });
  runtime.registerProvider("goal-fixture", {
    api: "openai-completions", apiKey: "local-test-only", baseUrl: "http://invalid.local",
    models: [{
      id: "fake", name: "Fake", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000, maxTokens: 1000,
    }],
    streamSimple(model, context) {
      requests.push(structuredClone(context));
      // A terminal fixture error bounds unexpected requests even if goal completion regresses.
      const exhausted = requests.length >= 6;
      const complete = !exhausted && options.completeAt(requests.length);
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: complete
          ? [{
            type: "toolCall", id: `finish-${requests.length}`, name: "update_goal",
            arguments: { status: "complete", reason: "Local fixture verified the deterministic check." },
          }]
          : [{ type: "text", text: "done" }],
        stopReason: exhausted ? "error" : complete ? "toolUse" : "stop", timestamp: Date.now(),
        ...(exhausted ? { errorMessage: "Goal fixture request limit exceeded." } : {}),
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      if (exhausted) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: complete ? "toolUse" : "stop", message });
      return stream;
    },
  });

  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.setProjectTrusted(false);
  settingsManager.applyOverrides({ retry: { enabled: false }, compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noContextFiles: true, noSkills: true, noPromptTemplates: true,
    extensionFactories: [
      { name: "pi-base", factory: piBaseExtension },
      { name: "probe", factory: probe },
    ],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);

  const manager = SessionManager.inMemory(cwd);
  manager.appendCustomEntry(AGENT_STATE_ENTRY, { name: "goal-fixture" });
  if (options.seedActiveGoal) {
    manager.appendCustomEntry(GOAL_STATE_ENTRY_TYPE, {
      goal: {
        version: 1, id: "seeded-goal", objective: "Seeded active objective", status: "active",
        tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: Date.now(), updatedAt: Date.now(),
      },
      statusBarEnabled: true,
    });
  }
  const result = await createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader, modelRuntime: runtime,
    model: runtime.getModel("goal-fixture", "fake")!, sessionManager: manager,
  });
  session = result.session;
  session.extensionRunner.onError((error) => errors.push(error));
  await session.bindExtensions({});
  return { requests, starts, filteredControls, errors, cwd };
}

describe("goal runtime compatibility with Pi 1.2.0 starting messages", () => {
  it("keeps exactly one control message per run and preserves the first goal_set guidance", async () => {
    // The idle /goal run must expose its goal_set starting message to the model (not filter it as
    // a duplicate), and the automatic continuation must add only one control message for the
    // second run. The deterministic second request lets the fixture complete the goal normally.
    const { requests, starts, filteredControls, errors, cwd } = await setup({ completeAt: (count) => count === 2 });

    await session!.prompt("/goal Verify the goal runtime fixture");
    await expect.poll(() => requests.length, { timeout: 5000 }).toBe(3);
    await expect.poll(() => session!.isIdle, { timeout: 5000 }).toBe(true);

    expect(starts).toEqual([
      { messageType: "custom", customKind: "goal_set", idle: false },
      { messageType: "custom", customKind: "continuation", idle: false },
    ]);
    expect(historyKinds()).toEqual(["goal_set", "continuation"]);
    expect(filteredControls[0]).toEqual(["goal_set"]);
    expect(filteredControls[1]).toEqual(["continuation"]);
    expect(filteredControls[2]).toEqual([]);

    // First run: the goal_set adoption guidance reaches the provider; the duplicate continuation
    // that the old unconditional hook appended is gone.
    expect(contextText(requests[0])).toContain("has set or replaced the active goal");
    expect(contextText(requests[0])).not.toContain("automatic system reminder");
    // Second run: the automatic continuation carries the continuation guidance.
    expect(contextText(requests[1])).toContain("automatic system reminder");
    expect(contextText(requests[1])).toContain("Verify the goal runtime fixture");

    // The agent system prompt guide survives the update_goal tool call within the same run.
    expect(systemText(requests[1])).toBe(systemText(requests[2]));
    expect(systemText(requests[2])).toContain(cwd);
    expect(systemText(requests[2])).toContain("Goal fixture system instruction.");

    expect(completedGoalStatus()).toBe("complete");
    expect(errors).toEqual([]);
  });

  it("still injects goal guidance for an actual user-triggered run", async () => {
    // A user run started while a goal is active must receive the visible continuation contract;
    // the starting-message skip applies only to the goal's own control messages.
    const { requests, starts, errors } = await setup({ seedActiveGoal: true, completeAt: (count) => count === 1 });

    await session!.sendUserMessage("continue the active goal");
    await expect.poll(() => session!.isIdle, { timeout: 5000 }).toBe(true);

    expect(starts).toEqual([{ messageType: "user", customKind: undefined, idle: false }]);
    expect(historyKinds()).toEqual(["continuation"]);
    expect(contextText(requests[0])).toContain("automatic system reminder");
    expect(completedGoalStatus()).toBe("complete");
    expect(errors).toEqual([]);
  });

  it("still injects goal guidance for an unrelated custom trigger", async () => {
    // A custom run started by another extension carries different details and is not the goal's
    // own starting message, so the current goal still injects its continuation guidance.
    const { requests, starts, errors } = await setup({ seedActiveGoal: true, completeAt: (count) => count === 1 });

    await session!.sendCustomMessage(
      { customType: "unrelated-extension", content: "ping", display: true, details: { kind: "ping" } },
      { triggerTurn: true },
    );
    await expect.poll(() => session!.isIdle, { timeout: 5000 }).toBe(true);

    expect(starts).toEqual([{ messageType: "custom", customKind: "ping", idle: false }]);
    expect(historyKinds().filter((kind) => kind === "continuation")).toHaveLength(1);
    expect(historyKinds()).toContain("ping");
    expect(contextText(requests[0])).toContain("automatic system reminder");
    // The unrelated custom message is not a goal-control message and must remain in context.
    expect(contextText(requests[0])).toContain("\"text\":\"ping\"");
    expect(completedGoalStatus()).toBe("complete");
    expect(errors).toEqual([]);
  });
});
