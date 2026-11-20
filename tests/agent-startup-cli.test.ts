import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempWorkspace } from "./helpers.js";

const cliPath = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

describe("agent startup CLI precedence", () => {
  let root: string | undefined;
  let cwd: string;
  let agentDir: string;

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  beforeAll(async () => {
    root = await createTempWorkspace();
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await Promise.all([
      writeFile(join(cwd, ".pi", "pi-base.json"), JSON.stringify({ defaultAgent: "planner" })),
      writeFile(join(agentDir, "agents", "planner.md"),
        "---\nname: planner\nmodel: cli-fixture/planner\nthinkingLevel: high\n---\nPlan only.\n"),
      writeFile(join(agentDir, "settings.json"), JSON.stringify({
        defaultProvider: "cli-fixture", defaultModel: "plain", defaultThinkingLevel: "medium",
      })),
      writeFile(join(agentDir, "models.json"), JSON.stringify({
        providers: {
          "cli-fixture": {
            api: "openai-completions", apiKey: "local-test-only", baseUrl: "http://127.0.0.1:1",
            models: [
              { id: "plain", reasoning: false },
              { id: "planner", reasoning: true },
              { id: "cli", reasoning: true },
              { id: "literal:low", reasoning: true },
            ],
          },
        },
      })),
    ]);
  });

  // Query the real Pi session after the extension starts. No prompt or provider request is sent.
  it.each([
    { label: "an explicit model keeps its model but still takes the Agent thinking default", args: ["--agent", "planner", "--model", "cli-fixture/cli"], model: "cli", thinking: "high" },
    { label: "an explicit thinking level survives switching away from a non-reasoning default model", args: ["--thinking", "low"], model: "planner", thinking: "low" },
    { label: "thinking shorthand is not overwritten by the configured Agent", args: ["--model", "cli-fixture/cli:low"], model: "cli", thinking: "low" },
    { label: "an explicit thinking flag wins over shorthand", args: ["--model", "cli-fixture/cli:low", "--thinking", "off"], model: "cli", thinking: "off" },
    { label: "a colon in a literal model ID is not thinking shorthand", args: ["--model", "cli-fixture/literal:low"], model: "literal:low", thinking: "high" },
    { label: "flag-like option values and positional text do not suppress Agent defaults", args: ["--system-prompt", "--thinking", "--", "--model", "cli-fixture/cli"], model: "planner", thinking: "high" },
  ])("$label", ({ args, model, thinking }) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_BASE_GLOBAL_SETTINGS_PATH: join(agentDir, "pi-base.json"),
    };
    delete env.NODE_V8_COVERAGE;
    delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, [
      cliPath, "--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp",
      "--approve", "-e", extensionPath, ...args,
    ], {
      cwd,
      env,
      input: '{"id":"state","type":"get_state"}\n',
      encoding: "utf8",
      timeout: 8_000,
      killSignal: "SIGKILL",
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("Extension error");
    const response = result.stdout.trim().split("\n")
      .map((line) => JSON.parse(line) as { id?: string })
      .find((event) => event.id === "state");
    expect(response).toMatchObject({
      success: true,
      data: { model: { provider: "cli-fixture", id: model }, thinkingLevel: thinking, messageCount: 0 },
    });
  });
});
