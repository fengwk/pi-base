import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piBaseExtension from "../index.js";
import { subagentRegistry } from "../src/subagent/registry.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

const runnerState = vi.hoisted(() => ({
  spawned: [] as Array<{ agentType: string; childDepth: number }>,
  prompts: [] as string[],
  disposed: 0,
}));

vi.mock("../src/subagent/runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/subagent/runner.js")>();
  return {
    ...actual,
    createRealSubagentFactory: () => ({
      spawn: async ({ agentType, childDepth }: { agentType: string; childDepth: number }) => {
        runnerState.spawned.push({ agentType, childDepth });
        return {
          sessionId: "it-child-session",
          prompt: async (text: string) => {
            runnerState.prompts.push(text);
          },
          collect: () => ({ report: "SLOW_DONE", toolCount: 1 }),
          abort: () => undefined,
          dispose: () => {
            runnerState.disposed += 1;
          },
        };
      },
      resume: async () => {
        throw new Error("resume is not used by this integration test");
      },
    }),
  };
});

async function writeAgentFile(agentDir: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = join(agentDir, "agents", relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true }).catch(() => undefined);
  await writeFile(absolutePath, content, "utf8");
}

const defaultModel = { provider: "provider-a", id: "model-a" };

let previousAgentDir: string | undefined;
let previousGlobalSettingsPath: string | undefined;

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  previousGlobalSettingsPath = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  runnerState.spawned.length = 0;
  runnerState.prompts.length = 0;
  runnerState.disposed = 0;
  subagentRegistry.clear();
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousGlobalSettingsPath === undefined) delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  else process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
  subagentRegistry.clear();
});

describe("subagent integration", () => {
  it("uses --agent startup selection to drive a delegating agent and execute task", async () => {
    // Intent: cover the real pi-base wiring across CLI flag handling, agent activation, task
    // injection, allowlist validation, and the subagent runner boundary without making a live LLM call.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const globalSettingsPath = join(agentDir, "global-pi-base.json");
    process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalSettingsPath;

    await writeFile(globalSettingsPath, JSON.stringify({}), "utf8");
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: defaultModel.provider, defaultModel: defaultModel.id, defaultThinkingLevel: "medium" }),
      "utf8",
    );
    await writeFile(join(agentDir, "SYSTEM.md"), "Default system prompt.", "utf8");
    await writeAgentFile(
      agentDir,
      "it-orchestrator.md",
      `---
name: it-orchestrator
description: Integration-test orchestrator
tools: []
subagents:
  - it-slowworker
---
Delegate exactly once.
`,
    );
    await writeAgentFile(
      agentDir,
      "it-slowworker.md",
      `---
name: it-slowworker
description: Integration-test worker
---
Return SLOW_DONE.
`,
    );

    const registry = createToolRegistry({ model: defaultModel, models: [defaultModel] });
    registry.setFlag("agent", "it-orchestrator");
    piBaseExtension(registry.pi as never);

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    expect(registry.getStatuses().get("00-pi-base-agent")).toContain("agent:it-orchestrator");
    expect(registry.getActiveTools()).toEqual(["task"]);

    const promptResult = await registry.emit(
      "before_agent_start",
      { systemPrompt: "BASE", systemPromptOptions: { cwd: root, selectedTools: registry.getActiveTools() } },
      { cwd: root },
    );
    const systemPrompt = String(promptResult?.systemPrompt ?? "");
    expect(systemPrompt).toContain("## Subagents");
    expect(systemPrompt).toContain("- it-slowworker: Integration-test worker");

    const result = await registry.getTool("task").execute(
      "task-1",
      {
        subagent_type: "it-slowworker",
        description: "slow check",
        prompt: "Run the slow worker integration check and return SLOW_DONE.",
      },
      undefined,
      undefined,
      {
        cwd: root,
        sessionManager: {
          getSessionId: () => "root-session",
          getEntries: () => registry.getEntries(),
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain('<task id="it-child-session" state="completed">');
    expect(getText(result)).toContain("SLOW_DONE");
    expect(runnerState.spawned).toEqual([{ agentType: "it-slowworker", childDepth: 2 }]);
    expect(runnerState.prompts).toEqual(["Run the slow worker integration check and return SLOW_DONE."]);
    expect(runnerState.disposed).toBe(1);
    expect(subagentRegistry.get("it-child-session")?.status).toBe("done");
  });
});
