import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { createTempWorkspace, createToolRegistry } from "./helpers.js";

async function writeAgentFile(agentDir: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = join(agentDir, "agents", relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true }).catch(() => undefined);
  await writeFile(absolutePath, content, "utf8");
}

async function writeProjectSettings(root: string, settings: unknown): Promise<void> {
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify(settings), "utf8");
}

const defaultModel = { provider: "provider-a", id: "model-a" };

let previousAgentDir: string | undefined;
let previousGlobal: string | undefined;

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  previousGlobal = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousGlobal === undefined) delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  else process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previousGlobal;
});

async function setupAgents(): Promise<{ root: string; globalPath: string }> {
  const root = await createTempWorkspace();
  const agentDir = await createTempWorkspace();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const globalPath = join(agentDir, "global-pi-base.json");
  await writeFile(globalPath, JSON.stringify({}), "utf8");
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalPath;

  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: defaultModel.provider, defaultModel: defaultModel.id, defaultThinkingLevel: "medium" }),
    "utf8",
  );
  await writeFile(join(agentDir, "SYSTEM.md"), "Default system prompt.", "utf8");
  // Orchestrator delegates to worker; worker has no subagents.
  await writeAgentFile(
    agentDir,
    "orchestrator.md",
    `---\nname: orchestrator\nmodel: ${defaultModel.provider}/${defaultModel.id}\ntools:\n  - read\n  - grep\nsubagents:\n  - worker\n---\nOrchestrate.\n`,
  );
  await writeAgentFile(
    agentDir,
    "worker.md",
    `---\nname: worker\ndescription: Run focused unit-of-work tasks.\nmodel: ${defaultModel.provider}/${defaultModel.id}\ntools:\n  - read\n---\nWork.\n`,
  );
  return { root, globalPath };
}

describe("task tool injection", () => {
  it("injects `task` for an agent with subagents while below maxDepth", async () => {
    // Intent: an agent declaring `subagents` at root depth (1 < default maxDepth 2) gains `task`.
    const { root } = await setupAgents();
    const registry = createToolRegistry({ model: defaultModel, models: [defaultModel] });
    piBaseExtension(registry.pi as never);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    await registry.runCommand("agent", "orchestrator", { cwd: root });
    const tools = registry.getActiveTools();
    expect(tools).toContain("task");
    expect(tools).toContain("read");
    expect(tools).toContain("grep");

    // Switching to an agent without subagents removes `task` again.
    await registry.runCommand("agent", "worker", { cwd: root });
    expect(registry.getActiveTools()).not.toContain("task");
  });

  it("withholds `task` when depth has reached maxDepth", async () => {
    // Intent: with maxDepth=1, even the root (depth 1) cannot delegate — no `task` injected.
    const { root } = await setupAgents();
    await writeProjectSettings(root, { subagent: { maxDepth: 1 } });
    const registry = createToolRegistry({ model: defaultModel, models: [defaultModel] });
    piBaseExtension(registry.pi as never);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    await registry.runCommand("agent", "orchestrator", { cwd: root });
    expect(registry.getActiveTools()).not.toContain("task");
  });

  it("injects task instructions and available subagents into the system prompt when delegating", async () => {
    // Intent: task instructions and the valid subagent types must be exposed only when `task` is active.
    const { root } = await setupAgents();
    await writeProjectSettings(root, { subagent: { maxTurns: 7 } });
    const registry = createToolRegistry({ model: defaultModel, models: [defaultModel] });
    piBaseExtension(registry.pi as never);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await registry.runCommand("agent", "orchestrator", { cwd: root });

    const result = await registry.emit(
      "before_agent_start",
      { systemPrompt: "BASE", systemPromptOptions: { cwd: root, selectedTools: registry.getActiveTools() } },
      { cwd: root },
    );
    const prompt = String(result?.systemPrompt ?? "");
    expect(prompt).toContain("You can delegate self-contained subtasks with the `task` tool.");
    expect(prompt).toContain("The main agent remains responsible for task decomposition, decisions, integration, validation, and final judgment.");
    expect(prompt).toContain("After 2-3 well-directed attempts without meaningful progress, take over the work, switch approaches, or report the blocker.");
    expect(prompt).toContain("The default is `7`");
    expect(prompt).toContain("phase report");
    expect(prompt).toContain("Set `subagent_type` to one of the names listed below.");
    expect(prompt).toContain("<available_subagents>");
    expect(prompt).toContain("</available_subagents>");
    expect(prompt).toContain("<name>worker</name>");
    expect(prompt).toContain("<description>Run focused unit-of-work tasks.</description>");

    // A non-delegating agent must not get the section.
    await registry.runCommand("agent", "worker", { cwd: root });
    const workerResult = await registry.emit(
      "before_agent_start",
      { systemPrompt: "BASE", systemPromptOptions: { cwd: root, selectedTools: registry.getActiveTools() } },
      { cwd: root },
    );
    expect(String(workerResult?.systemPrompt ?? "")).not.toContain("<available_subagents>");
  });

  it("uses the global maxTurns setting when the project does not override it", async () => {
    // Intent: the prompt's dynamically injected default must follow the same global-plus-project
    // settings resolution as task execution, including the global-only fallback.
    const { root, globalPath } = await setupAgents();
    await writeFile(globalPath, JSON.stringify({ subagent: { maxTurns: 9 } }), "utf8");
    const registry = createToolRegistry({ model: defaultModel, models: [defaultModel] });
    piBaseExtension(registry.pi as never);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await registry.runCommand("agent", "orchestrator", { cwd: root });

    const result = await registry.emit(
      "before_agent_start",
      { systemPrompt: "BASE", systemPromptOptions: { cwd: root, selectedTools: registry.getActiveTools() } },
      { cwd: root },
    );
    expect(String(result?.systemPrompt ?? "")).toContain("The default is `9`");
  });

  it("filters unknown subagents at load time so task is never injected for them", async () => {
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const globalPath = join(agentDir, "global-pi-base.json");
    await writeFile(globalPath, JSON.stringify({}), "utf8");
    process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalPath;
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: defaultModel.provider, defaultModel: defaultModel.id, defaultThinkingLevel: "medium" }),
      "utf8",
    );
    await writeFile(join(agentDir, "SYSTEM.md"), "Default system prompt.", "utf8");
    await writeAgentFile(
      agentDir,
      "broken-orchestrator.md",
      `---\nname: broken-orchestrator\nmodel: ${defaultModel.provider}/${defaultModel.id}\ntools:\n  - read\nsubagents:\n  - missing-worker\n---\nBroken.\n`,
    );

    const registry = createToolRegistry({ model: defaultModel, models: [defaultModel] });
    piBaseExtension(registry.pi as never);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await registry.runCommand("agent", "broken-orchestrator", { cwd: root });
    expect(registry.getActiveTools()).toEqual(["read"]);
  });
});
