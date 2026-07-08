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

async function setupAgents(): Promise<{ root: string }> {
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
    `---\nname: worker\nmodel: ${defaultModel.provider}/${defaultModel.id}\ntools:\n  - read\n---\nWork.\n`,
  );
  return { root };
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

  it("injects the available subagents (name + description) into the system prompt when delegating", async () => {
    // Intent: like OpenCode, the model must see which subagent_types are valid and what they do —
    // exposed via the system prompt (pi tool descriptions are static). Only when `task` is active.
    const { root } = await setupAgents();
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
    expect(prompt).toContain("## Subagents");
    expect(prompt).toContain("- worker:");

    // A non-delegating agent must not get the section.
    await registry.runCommand("agent", "worker", { cwd: root });
    const workerResult = await registry.emit(
      "before_agent_start",
      { systemPrompt: "BASE", systemPromptOptions: { cwd: root, selectedTools: registry.getActiveTools() } },
      { cwd: root },
    );
    expect(String(workerResult?.systemPrompt ?? "")).not.toContain("## Subagents");
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
