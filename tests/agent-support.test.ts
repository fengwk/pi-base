import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import piBaseExtension from "../index.js";
import { AGENT_STATE_ENTRY, registerAgentSupport } from "../src/agent-support.js";
import { CREATE_GOAL_TOOL_NAME, GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME } from "../src/goal/index.js";
import { DEPTH_ENTRY, ROOT_SESSION_ENTRY, rootSessionEntryData } from "../src/subagent/depth.js";
import { buildSystemPrompt, buildSystemPromptSections, createTempWorkspace, createToolRegistry } from "./helpers.js";

const BASE_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "bash",
  "edit",
  "write",
  "lsp_goto_definition",
  "lsp_workspace_symbols",
  "lsp_java_decompile",
] as const;
const DEFAULT_AGENT_TOOL_NAMES = [...BASE_TOOL_NAMES, CREATE_GOAL_TOOL_NAME];

function makeSkill(name: string, description: string, options?: { disableModelInvocation?: boolean }): Skill {
  return {
    name,
    description,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: {
      path: `/skills/${name}/SKILL.md`,
      source: "local",
      scope: "user",
      origin: "top-level",
      baseDir: `/skills/${name}`,
    },
    disableModelInvocation: options?.disableModelInvocation ?? false,
  };
}

async function writeAgentFile(agentDir: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = join(agentDir, "agents", relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true }).catch(() => undefined);
  await writeFile(absolutePath, content, "utf8");
}

async function writePiBaseConfig(root: string, settings: unknown): Promise<void> {
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify(settings), "utf8");
}

describe("agent support", () => {
  const previousGlobalSettingsPath = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;

  beforeEach(async () => {
    process.env.PI_BASE_GLOBAL_SETTINGS_PATH = join(await createTempWorkspace(), "global-pi-base.json");
  });

  afterEach(() => {
    if (previousGlobalSettingsPath === undefined) {
      delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
    } else {
      process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
    }
  });

  it("loads the checked-in agent examples with their configured models", async () => {
    // Intent: published Agent examples should form a self-contained catalog with valid model settings.
    const root = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const openaiModel = { provider: "openai", id: "gpt-5.6-sol" };
    const deepseekModel = { provider: "deepseek", id: "deepseek-v4-flash" };
    process.env.PI_CODING_AGENT_DIR = fileURLToPath(new URL("../examples", import.meta.url));
    try {
      const registry = createToolRegistry({
        model: openaiModel,
        models: [openaiModel, deepseekModel],
      });
      piBaseExtension(registry.pi as any);

      for (const [name, model, thinkingLevel] of [
        ["jiji", openaiModel, "max"],
        ["coder", deepseekModel, "max"],
        ["explorer", deepseekModel, "high"],
        ["helper", deepseekModel, "high"],
      ] as const) {
        await registry.runCommand("agent", name, { cwd: root });
        expect(registry.getCurrentModel()).toEqual(model);
        expect(registry.pi.getThinkingLevel()).toBe(thinkingLevel);
      }

      expect(registry.getNotifications().find((notification) =>
        notification.variant === "warning" && notification.message.includes("unknown subagents"))).toBeUndefined();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("reloads Agent runtime config before task-time subagent creation", async () => {
    // Intent: a live root session may replace a subagent definition between task calls; the next
    // spawn or resume must resolve model/thinking from the current file rather than startup cache.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "worker.md",
        "---\nname: worker\nmodel: deepseek/old-model\nthinkingLevel: high\n---\nOld worker.\n",
      );
      const registry = createToolRegistry();
      const handle = registerAgentSupport(registry.pi as never, { baseToolGuide: "" });

      expect(handle.resolveAgentRuntimeConfig("worker")).toEqual({
        model: { provider: "deepseek", modelId: "old-model" },
        thinkingLevel: "high",
      });

      await writeAgentFile(
        agentDir,
        "worker.md",
        "---\nname: worker\nmodel: openai/new-model\nthinkingLevel: max\n---\nNew worker.\n",
      );
      handle.refreshAgentCatalog({ cwd: root } as never);

      expect(handle.resolveAgentRuntimeConfig("worker")).toEqual({
        model: { provider: "openai", modelId: "new-model" },
        thinkingLevel: "max",
      });
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("switches agents from markdown definitions and restores defaults", async () => {
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const defaultModel = { provider: "provider-a", id: "model-a" };
    const plannerModel = { provider: "provider-b", id: "model-b" };

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          defaultProvider: defaultModel.provider,
          defaultModel: defaultModel.id,
          defaultThinkingLevel: "medium",
        }),
        "utf8",
      );
      await writeFile(join(agentDir, "SYSTEM.md"), "Default system prompt.", "utf8");
      await writeAgentFile(
        agentDir,
        "planner.md",
        `---
name: planner
description: Planning mode
model: ${plannerModel.provider}/${plannerModel.id}
thinkingLevel: high
tools:
  - read
  - grep
skills:
  - spec
---

You are the planner.
`,
      );

      const registry = createToolRegistry({
        model: defaultModel,
        models: [defaultModel, plannerModel],
      });
      piBaseExtension(registry.pi as any);

      await registry.emit("session_start", { reason: "startup" }, { cwd: root });
      expect(registry.getStatuses().get("00-pi-base-agent")).toContain("agent:default");

      await registry.runCommand("agent", "planner", { cwd: root });
      expect(registry.getActiveTools()).toEqual(["read", "grep"]);
      expect(registry.getCurrentModel()).toEqual(plannerModel);
      expect(registry.pi.getThinkingLevel()).toBe("high");
      expect(registry.getStatuses().get("00-pi-base-agent")).toContain("agent:planner");
      expect(registry.getNotifications()).toContainEqual({
        message: `Agent "planner" activated. model:${plannerModel.provider}/${plannerModel.id} thinking:high`,
        variant: "info",
      });

      const specSkill = makeSkill("spec", "Spec workflow");
      const otherSkill = makeSkill("other", "Other workflow");
      const plannerPrompt = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: "Default system prompt.",
          systemPromptOptions: {
            cwd: root,
            customPrompt: "Default system prompt.",
            appendSystemPrompt: "Appendix",
            contextFiles: [{ path: join(root, "AGENTS.md"), content: "Project rules" }],
            selectedTools: registry.getActiveTools(),
            skills: [specSkill, otherSkill],
          },
        },
        { cwd: root },
      );

      expect(plannerPrompt.systemPrompt).toContain("You are the planner.");
      expect(plannerPrompt.systemPrompt).not.toContain("Default system prompt.\nCurrent date:");
      expect(plannerPrompt.systemPrompt).toContain("<env>");
      expect(plannerPrompt.systemPrompt).toContain("</env>");
      expect(plannerPrompt.systemPrompt).toContain(`<cwd>\n${root}\n</cwd>`);
      // <env> must be preceded by a blank line so it does not glue to whatever came before.
      expect(plannerPrompt.systemPrompt).toMatch(/\n\n<env>/);
      // Exactly one <env> block: env info is owned by pi-base, not duplicated by upstream.
      expect((plannerPrompt.systemPrompt.match(/<env>/g) ?? []).length).toBe(1);
      expect((plannerPrompt.systemPrompt.match(/Current date:/g) ?? []).length).toBe(1);
      expect(plannerPrompt.systemPrompt).not.toContain("Current working directory:");
      expect(plannerPrompt.systemPromptOptions.forceSystemPrompt).toBeUndefined();
      expect(plannerPrompt.systemPrompt).toContain("Appendix");
      expect(plannerPrompt.systemPrompt).toContain("<name>spec</name>");
      expect(plannerPrompt.systemPrompt).not.toContain("<name>other</name>");
      expect(plannerPrompt.systemPrompt).not.toContain("**Your tool usage:**");

      await registry.pi.setModel(defaultModel as any);
      registry.setThinkingLevel("off");
      registry.pi.setActiveTools(["bash"]);
      await registry.emit("session_start", { reason: "reload" }, { cwd: root });
      expect(registry.getCurrentModel()).toEqual(defaultModel);
      expect(registry.getActiveTools()).toEqual(["read", "grep"]);
      expect(registry.pi.getThinkingLevel()).toBe("off");

      await registry.runCommand("agent", "default", { cwd: root });
      expect(registry.getCurrentModel()).toEqual(defaultModel);
      expect(registry.getActiveTools()).toEqual(DEFAULT_AGENT_TOOL_NAMES);
      expect(registry.pi.getThinkingLevel()).toBe("off");
      expect(registry.getStatuses().get("00-pi-base-agent")).toContain("agent:default");

      const defaultPrompt = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: `Default system prompt.${formatSkillsForPrompt([specSkill, otherSkill])}`,
          systemPromptOptions: {
            cwd: root,
            customPrompt: "Default system prompt.",
            selectedTools: registry.getActiveTools(),
            skills: [specSkill, otherSkill],
          },
        },
        { cwd: root },
      );

      expect(defaultPrompt.systemPrompt).toContain("Default system prompt.");
      expect(defaultPrompt.systemPrompt).not.toContain("You are the planner.");
      expect(defaultPrompt.systemPrompt).toContain("<name>spec</name>");
      expect(defaultPrompt.systemPrompt).toContain("<name>other</name>");
      expect(defaultPrompt.systemPrompt).not.toContain("**Your tool usage:**");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("accepts max thinking level for the configured default agent", async () => {
    // Intent: cover catalog parsing and configured-default activation together so a supported
    // thinking level cannot invalidate the named agent and silently trigger fallback.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "maximal.md",
        `---
name: maximal
thinkingLevel: max
---
Maximal prompt.
`,
      );
      await writePiBaseConfig(root, { defaultAgent: "maximal" });

      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.emit("session_start", { reason: "startup" }, { cwd: root });

      expect(registry.getStatuses().get("00-pi-base-agent")).toContain("agent:maximal");
      expect(registry.pi.getThinkingLevel()).toBe("max");
      expect(registry.getNotifications()).not.toContainEqual({
        message: expect.stringContaining('Agent "maximal" (from pi-base.json defaultAgent) not found'),
        variant: "warning",
      });
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("keeps resume session model and thinking level when restoring a persisted agent", async () => {
    // Intent: on resume, agent support should restore prompt/tools/skills from the persisted agent
    // without reapplying that agent's model or thinking level over the session's own state.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const sessionModel = { provider: "provider-a", id: "model-a" };
    const plannerModel = { provider: "provider-b", id: "model-b" };

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "planner.md",
        `---
name: planner
model: ${plannerModel.provider}/${plannerModel.id}
thinkingLevel: high
tools:
  - read
  - grep
---
Planner prompt.
`,
      );

      const registry = createToolRegistry({ model: sessionModel, models: [sessionModel, plannerModel] });
      piBaseExtension(registry.pi as any);
      registry.pi.appendEntry("pi-base-agent-state", { name: "planner" });
      registry.setThinkingLevel("low");
      await registry.emit("session_start", { reason: "resume" }, { cwd: root });

      expect(registry.getStatuses().get("00-pi-base-agent")).toContain("agent:planner");
      expect(registry.getCurrentModel()).toEqual(sessionModel);
      expect(registry.pi.getThinkingLevel()).toBe("low");
      expect(registry.getActiveTools()).toEqual(["read", "grep"]);
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("activates the agent named by the --agent startup flag when the session has none", async () => {
    // Intent: pi lets extensions register CLI flags; pi-base exposes `--agent <name>` so a session
    // can start in a specific agent non-interactively. It must apply only on fresh sessions (root),
    // fall back gracefully on unknown names, and never override an already-persisted agent (resume).
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const defaultModel = { provider: "provider-a", id: "model-a" };
    const plannerModel = { provider: "provider-b", id: "model-b" };

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: defaultModel.provider, defaultModel: defaultModel.id, defaultThinkingLevel: "medium" }),
        "utf8",
      );
      await writeFile(join(agentDir, "SYSTEM.md"), "Default system prompt.", "utf8");
      await writeAgentFile(
        agentDir,
        "planner.md",
        `---
name: planner
description: Planning mode
model: ${plannerModel.provider}/${plannerModel.id}
tools:
  - read
  - grep
---
You are the planner.
`,
      );

      // Case 1: --agent planner on a fresh session activates planner.
      const r1 = createToolRegistry({ model: defaultModel, models: [defaultModel, plannerModel] });
      r1.setFlag("agent", "planner");
      piBaseExtension(r1.pi as any);
      await r1.emit("session_start", { reason: "startup" }, { cwd: root });
      expect(r1.getStatuses().get("00-pi-base-agent")).toContain("agent:planner");
      expect(r1.getCurrentModel()).toEqual(plannerModel);
      expect(r1.getActiveTools()).toEqual(["read", "grep"]);

      // Case 2: unknown --agent name falls back to the default agent and surfaces a startup warning.
      const r2 = createToolRegistry({ model: defaultModel, models: [defaultModel, plannerModel] });
      r2.setFlag("agent", "does-not-exist");
      piBaseExtension(r2.pi as any);
      await r2.emit("session_start", { reason: "startup" }, { cwd: root });
      expect(r2.getStatuses().get("00-pi-base-agent")).toContain("agent:default");
      expect(r2.getNotifications().at(-1)).toMatchObject({
        variant: "warning",
        message: expect.stringContaining('from --agent'),
      });

      // Case 3: a session that already persisted an agent ignores the flag (resume semantics).
      const r3 = createToolRegistry({ model: defaultModel, models: [defaultModel, plannerModel] });
      r3.setFlag("agent", "planner");
      piBaseExtension(r3.pi as any);
      r3.pi.appendEntry("pi-base-agent-state", { name: "default" });
      await r3.emit("session_start", { reason: "startup" }, { cwd: root });
      expect(r3.getStatuses().get("00-pi-base-agent")).toContain("agent:default");
      expect(r3.getActiveTools()).not.toEqual(["read", "grep"]);

      // Case 4: an invalid persisted session agent falls back to default and still warns at startup.
      const r4 = createToolRegistry({ model: defaultModel, models: [defaultModel, plannerModel] });
      piBaseExtension(r4.pi as any);
      r4.pi.appendEntry("pi-base-agent-state", { name: "deleted-agent" });
      await r4.emit("session_start", { reason: "startup" }, { cwd: root });
      expect(r4.getStatuses().get("00-pi-base-agent")).toContain("agent:default");
      expect(r4.getNotifications().at(-1)).toMatchObject({
        variant: "warning",
        message: expect.stringContaining('from session entry'),
      });
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("activates configured defaultAgent on fresh sessions and falls back cleanly", async () => {
    // Intent: pi-base.json should be able to pick the startup agent for fresh root sessions
    // without touching resumed sessions. Explicit --agent still wins, and unknown configured
    // names must fall back to the built-in default agent.
    const rootWithConfiguredDefault = await createTempWorkspace();
    const rootWithFlagOverride = await createTempWorkspace();
    const rootWithMissingDefault = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const defaultModel = { provider: "provider-a", id: "model-a" };
    const plannerModel = { provider: "provider-b", id: "model-b" };

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: defaultModel.provider, defaultModel: defaultModel.id, defaultThinkingLevel: "medium" }),
        "utf8",
      );
      await writeFile(join(agentDir, "SYSTEM.md"), "Default system prompt.", "utf8");
      await writeAgentFile(
        agentDir,
        "planner.md",
        `---
name: planner
description: Planning mode
model: ${plannerModel.provider}/${plannerModel.id}
tools:
  - read
  - grep
---
You are the planner.
`,
      );

      // Case 1: fresh session with configured defaultAgent starts in that agent.
      await writePiBaseConfig(rootWithConfiguredDefault, { defaultAgent: "planner" });
      const r1 = createToolRegistry({ model: defaultModel, models: [defaultModel, plannerModel] });
      piBaseExtension(r1.pi as any);
      await r1.emit("session_start", { reason: "startup" }, { cwd: rootWithConfiguredDefault });
      expect(r1.getStatuses().get("00-pi-base-agent")).toContain("agent:planner");
      expect(r1.getCurrentModel()).toEqual(plannerModel);
      expect(r1.getActiveTools()).toEqual(["read", "grep"]);

      // Case 2: explicit --agent still overrides the configured defaultAgent.
      await writePiBaseConfig(rootWithFlagOverride, { defaultAgent: "planner" });
      const r2 = createToolRegistry({ model: defaultModel, models: [defaultModel, plannerModel] });
      r2.setFlag("agent", "default");
      piBaseExtension(r2.pi as any);
      await r2.emit("session_start", { reason: "startup" }, { cwd: rootWithFlagOverride });
      expect(r2.getStatuses().get("00-pi-base-agent")).toContain("agent:default");
      expect(r2.getActiveTools()).not.toEqual(["read", "grep"]);

      // Case 3: unknown configured defaultAgent reports the problem and falls back cleanly.
      await writePiBaseConfig(rootWithMissingDefault, { defaultAgent: "does-not-exist" });
      const r3 = createToolRegistry({ model: defaultModel, models: [defaultModel, plannerModel] });
      piBaseExtension(r3.pi as any);
      await r3.emit("session_start", { reason: "startup" }, { cwd: rootWithMissingDefault });
      expect(r3.getStatuses().get("00-pi-base-agent")).toContain("agent:default");
      expect(r3.getNotifications().at(-1)).toMatchObject({
        variant: "warning",
        message: expect.stringContaining('from pi-base.json defaultAgent'),
      });
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("warns about malformed agent files and ignores them", async () => {
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeFile(join(agentDir, "SYSTEM.md"), "Default system prompt.", "utf8");
      await writeAgentFile(
        agentDir,
        "broken.md",
        `---
name: broken
tools: nope
---

Broken agent.
`,
      );

      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.emit("session_start", { reason: "startup" }, { cwd: root });

      expect(warn).not.toHaveBeenCalled();
      expect(registry.getNotifications()).toContainEqual({
        message: expect.stringContaining('field "tools" must be an array of strings'),
        variant: "warning",
      });

      await registry.runCommand("agent", "broken", { cwd: root });
      expect(registry.getNotifications().at(-1)?.message).toContain('Unknown agent "broken"');
    } finally {
      warn.mockRestore();
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("warns about markdown files without a frontmatter name and ignores them", async () => {
    // Intent: unrelated Markdown discovered by the recursive scan must not silently become an Agent.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(agentDir, ".pytest_cache/README.md", "# pytest cache directory #\n");

      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.emit("session_start", { reason: "startup" }, { cwd: root });

      expect(warn).not.toHaveBeenCalled();
      expect(registry.getNotifications()).toContainEqual({
        message: expect.stringContaining('missing required frontmatter field "name"'),
        variant: "warning",
      });

      await registry.runCommand("agent", "README", { cwd: root });
      expect(registry.getNotifications().at(-1)?.message).toContain('Unknown agent "README"');
    } finally {
      warn.mockRestore();
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("rejects unknown frontmatter fields instead of letting tool-policy typos inherit all tools", async () => {
    // Intent: an invalid `toools` key must not be treated like an omitted `tools` policy, because
    // omission intentionally inherits every eligible tool while the typo intends an empty policy.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "typo.md",
        `---
name: typo
toools: []
---
Typo prompt.
`,
      );

      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.emit("session_start", { reason: "startup" }, { cwd: root });

      expect(warn).not.toHaveBeenCalled();
      expect(registry.getNotifications()).toContainEqual({
        message: expect.stringContaining("unknown frontmatter field: toools"),
        variant: "warning",
      });
      await registry.runCommand("agent", "typo", { cwd: root });
      expect(registry.getNotifications().at(-1)).toMatchObject({
        variant: "error",
        message: expect.stringContaining('Unknown agent "typo"'),
      });
      expect(registry.getStatuses().get("00-pi-base-agent")).toContain("agent:default");
    } finally {
      warn.mockRestore();
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("uses summaries for completions and defaults agents without a tool allowlist to all base tools", async () => {
    // Intent: /agent completion is the discoverability surface for agents, and
    // omitting `tools` should not accidentally disable the baseline toolset.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const model = { provider: "provider-b", id: "model-b" };

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "modeler.md",
        `---
name: modeler
model: ${model.provider}/${model.id}
thinkingLevel: low
---
`,
      );

      const registry = createToolRegistry({ models: [model] });
      piBaseExtension(registry.pi as any);

      const completions = registry.getCommand("agent").getArgumentCompletions("mod");
      expect(completions).toEqual([{
        value: "modeler",
        label: "modeler",
        description: `${model.provider}/${model.id} | thinking:low`,
      }]);

      await registry.runCommand("agent", "modeler", { cwd: root });
      expect(registry.getActiveTools()).toEqual(DEFAULT_AGENT_TOOL_NAMES);
      expect(registry.getCurrentModel()).toEqual(model);
      expect(registry.pi.getThinkingLevel()).toBe("low");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("hints usage when /agent runs without a name in a non-interactive context", async () => {
    // Intent: without a UI there is no picker, so a bare /agent must surface an
    // actionable usage hint instead of silently doing nothing.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "planner.md",
        `---
name: planner
---

Planner prompt.
`,
      );

      const registry = createToolRegistry({ hasUI: false });
      piBaseExtension(registry.pi as any);

      await registry.runCommand("agent", "", { cwd: root, hasUI: false });

      const notification = registry.getNotifications().at(-1);
      expect(notification?.variant).toBe("warning");
      expect(notification?.message).toContain("Usage: /agent <name>");
      expect(notification?.message).toContain("planner");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("shows the current agent in the footer before other inline statuses", async () => {
    // Intent: the active agent should be visible in the footer as the first
    // inline status so users always know which agent owns the current prompt.
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    const defaultFooterLines = registry.renderFooter(120);
    expect(defaultFooterLines.length).toBeGreaterThanOrEqual(3);
    expect(defaultFooterLines.at(-1) ?? "").toContain("agent:default");
    expect((defaultFooterLines.at(-1) ?? "").indexOf("agent:default")).toBe(0);

    await registry.emit("session_shutdown", {}, { cwd: root });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "named.md",
        `---
name: named
---

Named prompt.
`,
      );
      await registry.runCommand("agent", "named", { cwd: root });
      const namedFooterLines = registry.renderFooter(120);
      expect(namedFooterLines.length).toBeGreaterThanOrEqual(3);
      expect(namedFooterLines.at(-1) ?? "").toContain("agent:named");
      expect((namedFooterLines.at(-1) ?? "").indexOf("agent:named")).toBe(0);
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("truncates long agent summaries in selector items and command completions", async () => {
    // Intent: /agent rendering must respect terminal column width, not only raw
    // string length, so wide CJK descriptions still collapse into one line.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const longDescription = `${"长".repeat(60)}\nCRITICAL: this second line must never appear in selector items.`;
    const selectedItems: string[][] = [];

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "verbose.md",
        `---
name: verbose
description: |
  ${longDescription.replace(/\n/g, "\n  ")}
---

Verbose prompt.
`,
      );
      await writeAgentFile(
        agentDir,
        "verbose-copy.md",
        `---
name: verbose-copy
description: |
  ${longDescription.replace(/\n/g, "\n  ")}
---

Verbose prompt.
`,
      );

      const registry = createToolRegistry({
        ui: {
          select: async (_title: string, items: string[]) => {
            selectedItems.push(items);
            return items.find((item) => item.startsWith("verbose - ")) ?? items[0];
          },
        },
      });
      piBaseExtension(registry.pi as any);

      const completions = registry.getCommand("agent").getArgumentCompletions("ver");
      expect(completions).toHaveLength(2);
      expect(completions[0]?.description).not.toBe(longDescription);
      expect(completions[0]?.description).not.toContain("CRITICAL:");
      expect(completions[0]?.description).toMatch(/…$/);

      await registry.runCommand("agent", "", { cwd: root });
      expect(selectedItems).toHaveLength(1);
      const verboseItem = selectedItems[0]?.find((item) => item.startsWith("verbose - "));
      const duplicateItem = selectedItems[0]?.find((item) => item.startsWith("verbose-copy - "));
      expect(verboseItem).toBeDefined();
      expect(duplicateItem).toBeDefined();
      expect(verboseItem).not.toContain(longDescription);
      expect(verboseItem).not.toContain("CRITICAL:");
      expect(verboseItem).toMatch(/…$/);
      expect(duplicateItem).not.toContain(longDescription);
      expect(duplicateItem).not.toContain("CRITICAL:");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("excludes built-ins and preserves extension tools when an agent inherits all registered tools", async () => {
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "unrestricted.md",
        `---
name: unrestricted
---

Unrestricted prompt.
`,
      );

      const registry = createToolRegistry();
      registry.pi.registerTool({
        name: "ls",
        sourceInfo: { source: "builtin" },
        execute: async () => ({ content: [] }),
      });
      registry.pi.registerTool({
        name: "other_extension_tool",
        sourceInfo: { source: "local" },
        execute: async () => ({ content: [] }),
      });
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "unrestricted", { cwd: root });

      expect(registry.getActiveTools()).toContain("read");
      expect(registry.getActiveTools()).toContain("other_extension_tool");
      expect(registry.getActiveTools()).not.toContain("ls");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("treats explicit empty tool and skill arrays as disabled instead of inheriting all", async () => {
    // Intent: omitted fields mean "all", while an explicit empty array must
    // remain a real empty allowlist so users can disable tools and skills.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const model = { provider: "provider-b", id: "model-b" };

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "locked.md",
        `---
name: locked
model: ${model.provider}/${model.id}
tools: []
skills: []
---

Locked prompt.
`,
      );

      const registry = createToolRegistry({ models: [model] });
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "locked", { cwd: root });

      expect(registry.getActiveTools()).toEqual([]);

      const specSkill = makeSkill("spec", "Spec workflow");
      const otherSkill = makeSkill("other", "Other workflow");
      const rebuiltPrompt = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: "Incoming prompt should be ignored.",
          systemPromptOptions: {
            cwd: root,
            customPrompt: "Default system prompt.",
            selectedTools: registry.getActiveTools(),
            skills: [specSkill, otherSkill],
          },
        },
        { cwd: root },
      );

      expect(rebuiltPrompt.systemPrompt).toContain("Locked prompt.");
      expect(rebuiltPrompt.systemPrompt).not.toContain("Incoming prompt should be ignored.");
      expect(rebuiltPrompt.systemPrompt).not.toContain("<name>spec</name>");
      expect(rebuiltPrompt.systemPrompt).not.toContain("<name>other</name>");
      expect(rebuiltPrompt.systemPrompt).not.toContain("The following skills provide specialized instructions for specific tasks.");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("warns for unavailable tool and skill allowlist names without rejecting later dynamic registration", async () => {
    // Intent: typos in allowlists must be visible, but an MCP-style tool that registers after
    // activation must remain eligible rather than being permanently removed during catalog parsing.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const model = { provider: "provider-a", id: "model-a" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "dynamic-allowlist.md",
        `---
name: dynamic-allowlist
tools:
  - read
  - mcp_late_tool
skills:
  - known-skill
  - late-skill
---
Dynamic allowlist prompt.
`,
      );

      const registry = createToolRegistry({ model, models: [model] });
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "dynamic-allowlist", { cwd: root });

      expect(registry.getActiveTools()).toEqual(["read"]);
      expect(registry.getNotifications()).toContainEqual({
        message: expect.stringContaining("tools that are not currently available: mcp_late_tool"),
        variant: "warning",
      });

      const knownSkill = makeSkill("known-skill", "Known workflow");
      await registry.emit(
        "before_agent_start",
        {
          systemPrompt: "BASE",
          systemPromptOptions: { cwd: root, selectedTools: registry.getActiveTools(), skills: [knownSkill] },
        },
        { cwd: root },
      );
      expect(registry.getNotifications()).toContainEqual({
        message: expect.stringContaining("skills that are not currently available: late-skill"),
        variant: "warning",
      });

      registry.pi.registerTool({
        name: "mcp_late_tool",
        sourceInfo: { source: "local" },
        execute: async () => ({ content: [] }),
      });
      await registry.emit("model_select", { model }, { cwd: root });
      expect(registry.getActiveTools()).toEqual(["read", "mcp_late_tool"]);

      const lateSkill = makeSkill("late-skill", "Late workflow");
      const prompt = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: "BASE",
          systemPromptOptions: {
            cwd: root,
            selectedTools: registry.getActiveTools(),
            skills: [knownSkill, lateSkill],
          },
        },
        { cwd: root },
      );
      expect(prompt.systemPrompt).toContain("<name>late-skill</name>");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("does not write agent diagnostics from a headless subagent into the parent terminal", async () => {
    // Intent: in-process child sessions have no UI context but share the root TUI's stderr.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "headless.md",
        `---
name: headless
tools:
  - read
  - unavailable_tool
---
Headless prompt.
`,
      );

      const registry = createToolRegistry({ hasUI: false });
      piBaseExtension(registry.pi as any);
      registry.pi.appendEntry(AGENT_STATE_ENTRY, { name: "headless" });
      registry.pi.appendEntry(DEPTH_ENTRY, { depth: 2 });
      registry.pi.appendEntry(ROOT_SESSION_ENTRY, rootSessionEntryData("headless-root-without-host"));

      await registry.emit("session_start", { reason: "startup" }, { cwd: root, hasUI: false, mode: "print" });

      expect(registry.getActiveTools()).toEqual(["read"]);
      expect(registry.getNotifications()).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("allows explicit agent tool policies to opt into create_goal", async () => {
    // Intent: runtime-owned goal tools must not silently broaden an explicit allowlist, while an
    // agent that names create_goal must retain it and receive read/update controls once active.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "goal-capable.md",
        `---
name: goal-capable
tools: [create_goal]
---

Goal-capable prompt.
`,
      );

      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "goal-capable", { cwd: root });
      expect(registry.getActiveTools()).toEqual([CREATE_GOAL_TOOL_NAME]);

      await registry.runCommand("goal", "Finish the explicit goal", { cwd: root });
      expect(registry.getActiveTools()).toEqual([CREATE_GOAL_TOOL_NAME, GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME]);
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("shows a friendly warning when an agent references an unknown model", async () => {
    // Intent: a bad provider/modelId should not fail silently; the user should
    // get a concrete hint that the frontmatter or enabled model config is wrong.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "missing-model.md",
        `---
name: missing-model
model: missing-provider/missing-model
---
`,
      );

      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "missing-model", { cwd: root });

      expect(registry.getNotifications()).toContainEqual({
        message: 'Agent "missing-model": model missing-provider/missing-model not found. Keeping the current session model.',
        variant: "warning",
      });
      expect(registry.getStatuses().get("00-pi-base-agent")).toBe("agent:missing-model");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("keeps the current model and reports only effective values when setModel returns false", async () => {
    // Intent: no-auth fallback still activates prompt/tools, but the success notification must not
    // claim that the configured model or its coupled thinking level took effect.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const currentModel = { provider: "provider-a", id: "model-a" };
    const targetModel = { provider: "provider-b", id: "model-b" };

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "no-auth.md",
        `---
name: no-auth
model: ${targetModel.provider}/${targetModel.id}
thinkingLevel: high
tools:
  - read
---
`,
      );

      const registry = createToolRegistry({ model: currentModel, models: [currentModel, targetModel] });
      registry.pi.setModel = vi.fn(async () => false);
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "no-auth", { cwd: root });

      expect(registry.getCurrentModel()).toEqual(currentModel);
      expect(registry.pi.getThinkingLevel()).toBe("off");
      expect(registry.getActiveTools()).toEqual(["read"]);
      expect(registry.getStatuses().get("00-pi-base-agent")).toBe("agent:no-auth");
      expect(registry.getNotifications()).toContainEqual({
        message: 'Agent "no-auth" activated.',
        variant: "info",
      });
      expect(registry.getNotifications()).not.toContainEqual(expect.objectContaining({
        message: expect.stringContaining(`model:${targetModel.provider}/${targetModel.id}`),
      }));
      expect(registry.getNotifications()).not.toContainEqual(expect.objectContaining({
        message: expect.stringContaining("thinking:high"),
      }));
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("looks up models with the registry receiver intact", async () => {
    // Intent: pi-coding-agent's ModelRegistry.find depends on `this.models`.
    // Calling the method without its receiver crashes with `reading 'models'`.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const model = { provider: "provider-b", id: "model-b" };

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "bound-model.md",
        `---
name: bound-model
model: ${model.provider}/${model.id}
---
`,
      );

      const backingModels = new Map([[`${model.provider}/${model.id}`, model]]);
      const registry = createToolRegistry({
        models: [model],
        modelRegistry: {
          models: backingModels,
          find(this: { models: Map<string, typeof model> }, provider: string, modelId: string) {
            return this.models.get(`${provider}/${modelId}`);
          },
          isUsingOAuth: () => false,
        },
      });
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "bound-model", { cwd: root });

      expect(registry.getCurrentModel()).toEqual(model);
      expect(registry.getStatuses().get("00-pi-base-agent")).toBe("agent:bound-model");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("keeps /agent usable when model activation throws and shows a friendly warning", async () => {
    // Intent: runtime/provider bugs inside pi.setModel should not crash the
    // /agent command; keep the switch alive and surface a configuration hint.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const model = { provider: "provider-b", id: "model-b" };

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "broken-model.md",
        `---
name: broken-model
model: ${model.provider}/${model.id}
---
`,
      );

      const registry = createToolRegistry({ models: [model] });
      registry.pi.setModel = async () => {
        throw new Error("Cannot read properties of undefined (reading 'models')");
      };
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "broken-model", { cwd: root });

      expect(registry.getNotifications()).toContainEqual({
        message: 'Agent "broken-model": failed to activate model provider-b/model-b. Keeping the current session model.',
        variant: "warning",
      });
      expect(registry.getStatuses().get("00-pi-base-agent")).toBe("agent:broken-model");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("keeps /agent usable when applying thinking level throws and shows a friendly warning", async () => {
    // Intent: model-capability/provider bugs inside pi.setThinkingLevel should
    // not bubble out of /agent; keep the switch usable and explain the issue.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const model = { provider: "provider-b", id: "model-b" };

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "broken-thinking.md",
        `---
name: broken-thinking
model: ${model.provider}/${model.id}
thinkingLevel: high
---
`,
      );

      const registry = createToolRegistry({ models: [model] });
      registry.pi.setThinkingLevel = () => {
        throw new Error("Cannot read properties of undefined (reading 'models')");
      };
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "broken-thinking", { cwd: root });

      expect(registry.getNotifications()).toContainEqual({
        message: 'Agent "broken-thinking": failed to apply thinking level high. Keeping the current session thinking level.',
        variant: "warning",
      });
      expect(registry.getStatuses().get("00-pi-base-agent")).toBe("agent:broken-thinking");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("keeps an activated agent when persisting its session entry fails", async () => {
    // Intent: model/tools/status are already committed before session persistence; appendEntry failure
    // must be a non-fatal warning instead of reporting a failed switch with partially changed state.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "persistence-warning.md",
        `---
name: persistence-warning
tools:
  - read
---
`,
      );

      const registry = createToolRegistry();
      registry.pi.appendEntry = () => {
        throw new Error("session storage unavailable");
      };
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "persistence-warning", { cwd: root });

      expect(registry.getStatuses().get("00-pi-base-agent")).toBe("agent:persistence-warning");
      expect(registry.getActiveTools()).toEqual(["read"]);
      expect(registry.getNotifications()).toContainEqual({
        message: 'Agent "persistence-warning" activated, but its session state could not be saved: session storage unavailable',
        variant: "warning",
      });
      expect(registry.getNotifications()).not.toContainEqual(expect.objectContaining({
        message: expect.stringContaining("activation failed"),
      }));
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("rolls back model, thinking, and tools when tool activation fails before committing agent state", async () => {
    // Intent: the tool switch is the final fallible activation step; if it fails after model and
    // thinking changes, every runtime value must return to its prior state and no status/session
    // entry may claim that the target agent became active.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const currentModel = { provider: "provider-a", id: "model-a" };
    const targetModel = { provider: "provider-b", id: "model-b" };

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "transactional.md",
        `---
name: transactional
model: ${targetModel.provider}/${targetModel.id}
thinkingLevel: high
tools:
  - read
---
`,
      );

      const registry = createToolRegistry({ model: currentModel, models: [currentModel, targetModel] });
      piBaseExtension(registry.pi as any);
      await registry.emit("session_start", { reason: "startup" }, { cwd: root });
      registry.setThinkingLevel("low");
      registry.pi.setActiveTools(["bash"]);
      const entriesBefore = registry.getEntries();
      const originalSetActiveTools = registry.pi.setActiveTools.bind(registry.pi);
      let rejectNextToolUpdate = true;
      registry.pi.setActiveTools = (names: string[]) => {
        if (rejectNextToolUpdate) {
          rejectNextToolUpdate = false;
          throw new Error("tool registry rejected update");
        }
        originalSetActiveTools(names);
      };

      await registry.runCommand("agent", "transactional", { cwd: root });

      expect(registry.getCurrentModel()).toEqual(currentModel);
      expect(registry.pi.getThinkingLevel()).toBe("low");
      expect(registry.getActiveTools()).toEqual(["bash"]);
      expect(registry.getStatuses().get("00-pi-base-agent")).toBe("agent:default");
      expect(registry.getEntries()).toEqual(entriesBefore);
      expect(registry.getNotifications()).toContainEqual({
        message: 'Agent "transactional": activation failed: failed to apply tools: tool registry rejected update.',
        variant: "error",
      });
      expect(registry.getNotifications()).not.toContainEqual({
        message: expect.stringContaining('Agent "transactional" activated.'),
        variant: "info",
      });
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("reports rollback failures without crashing the /agent command", async () => {
    // Intent: a tool setter that also rejects rollback must be surfaced as an explicit rollback
    // failure instead of bubbling out or pretending that the target agent activated cleanly.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "broken-tools.md",
        `---
name: broken-tools
---
`,
      );

      const registry = createToolRegistry();
      registry.pi.setActiveTools = () => {
        throw new Error("Cannot read properties of undefined (reading 'models')");
      };
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "broken-tools", { cwd: root });

      expect(registry.getNotifications()).toContainEqual({
        message: expect.stringMatching(/Agent "broken-tools": activation failed: failed to apply tools: .*Rollback failed: tools:/),
        variant: "error",
      });
      expect(registry.getStatuses().get("00-pi-base-agent")).toBeUndefined();
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("inherits the Pi-loaded custom prompt for empty-body agents using structured options", async () => {
    // Intent: an empty-body agent changes skills, not Pi's preamble, addendum or context.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "skill-filter.md",
        `---
name: skill-filter
skills:
  - spec
---
`,
      );

      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "skill-filter", { cwd: root });

      const specSkill = makeSkill("spec", "Spec workflow");
      const otherSkill = makeSkill("other", "Other workflow");
      const customPrompt = "Default system prompt.";
      const filtered = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: `Incoming prompt should be ignored.${formatSkillsForPrompt([specSkill, otherSkill])}`,
          systemPromptOptions: {
            cwd: root,
            customPrompt,
            appendSystemPrompt: "Appendix",
            contextFiles: [{ path: join(root, "AGENTS.md"), content: "Project rules" }],
            selectedTools: ["read"],
            skills: [specSkill, otherSkill],
          },
        },
        { cwd: root },
      );

      expect(filtered.systemPrompt).toContain(customPrompt);
      expect(filtered.systemPrompt).not.toContain("Incoming prompt should be ignored.");
      expect(filtered.systemPrompt).toContain("Appendix");
      expect(filtered.systemPrompt).toContain("<project_context>");
      expect(filtered.systemPrompt).toContain("</project_context>");
      expect(filtered.systemPrompt).toContain(`<project_instructions path="${join(root, "AGENTS.md")}">`);
      expect(filtered.systemPrompt).toContain("Project rules");
      expect(filtered.systemPrompt).toContain("<name>spec</name>");
      expect(filtered.systemPrompt).not.toContain("<name>other</name>");
      expect(filtered.systemPrompt).not.toContain("**Your tool usage:**");

      const allFiltered = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: "Incoming prompt should still be ignored.",
          systemPromptOptions: {
            cwd: root,
            customPrompt,
            selectedTools: ["read"],
            skills: [otherSkill],
          },
        },
        { cwd: root },
      );
      expect(allFiltered.systemPrompt).toContain(customPrompt);
      expect(allFiltered.systemPrompt).not.toContain("Incoming prompt should still be ignored.");
      expect(allFiltered.systemPrompt).not.toContain("<available_skills>");
      expect(allFiltered.systemPrompt).not.toContain("The following skills provide specialized instructions for specific tasks.");
      expect(allFiltered.systemPrompt).not.toContain("<name>spec</name>");
      expect(allFiltered.systemPrompt).not.toContain("<name>other</name>");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("supports * patterns in skill allowlists", async () => {
    // Intent: a skill pattern must expose every matching skill without treating the pattern itself
    // as unavailable, while unmatched patterns still produce the existing configuration warning.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "skill-patterns.md",
        `---
name: skill-patterns
skills:
  - music-dev-*
  - dev
  - missing-*
---
`,
      );
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "skill-patterns", { cwd: root });

      const devSkill = makeSkill("dev", "Development workflow");
      const musicDevSkill = makeSkill("music-dev", "Music development overview");
      const ddbSkill = makeSkill("music-dev-ddb", "DDB workflow");
      const nydusSkill = makeSkill("music-dev-nydus", "Nydus workflow");
      const otherSkill = makeSkill("other", "Other workflow");
      const result = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: "Incoming prompt should be ignored.",
          systemPromptOptions: {
            cwd: root,
            customPrompt: "Default system prompt.",
            selectedTools: ["read"],
            skills: [devSkill, musicDevSkill, ddbSkill, nydusSkill, otherSkill],
          },
        },
        { cwd: root },
      );

      expect(result.systemPrompt).toContain("<name>dev</name>");
      expect(result.systemPrompt).toContain("<name>music-dev-ddb</name>");
      expect(result.systemPrompt).toContain("<name>music-dev-nydus</name>");
      expect(result.systemPrompt).not.toContain("<name>music-dev</name>");
      expect(result.systemPrompt).not.toContain("<name>other</name>");
      expect(registry.getNotifications()).toContainEqual({
        message: expect.stringContaining("skills that are not currently available: missing-*"),
        variant: "warning",
      });
      expect(registry.getNotifications()).not.toContainEqual({
        message: expect.stringContaining("music-dev-*"),
        variant: "warning",
      });
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("escapes normalized cwd while leaving project context rendering to Pi", async () => {
    // Intent: cwd metadata stays text, while shared contextFiles retain Pi's raw-input contract.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const craftedCwd = `${root}\\</cwd><injected attr="cwd">`;

    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(agentDir, "xml-safe.md", `---\nname: xml-safe\n---\nXML-safe prompt.\n`);
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "xml-safe", { cwd: craftedCwd });

      const customResult = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: "BASE",
          systemPromptOptions: {
            cwd: craftedCwd,
            customPrompt: "Fallback prompt.",
            selectedTools: ["read"],
            contextFiles: [{
              path: "AGENTS.md",
              content: "Use <safe> & stable.",
            }],
          },
        },
        { cwd: craftedCwd },
      );
      expect(customResult.systemPrompt).toContain('<project_instructions path="AGENTS.md">\nUse <safe> & stable.\n</project_instructions>');
      expect(customResult.systemPrompt).not.toContain("<injected>");
      expect(customResult.systemPrompt).toContain(
        `<cwd>\n${root}/&lt;/cwd&gt;&lt;injected attr=&quot;cwd&quot;&gt;\n</cwd>`,
      );
      expect((customResult.systemPrompt.match(/<\/env>/g) ?? [])).toHaveLength(1);
      expect((customResult.systemPrompt.match(/<\/cwd>/g) ?? [])).toHaveLength(1);
      expect(customResult.systemPromptOptions.contextFiles).toEqual([{
        path: "AGENTS.md",
        content: "Use <safe> & stable.",
      }]);

      await registry.runCommand("agent", "default", { cwd: craftedCwd });
      const rawOptions = {
        cwd: craftedCwd,
        selectedTools: ["read"],
        contextFiles: [{ path: "AGENTS.md", content: "Use <safe> & stable." }],
      };
      const fallbackResult = await registry.emit(
        "before_agent_start",
        { systemPrompt: buildSystemPrompt(rawOptions), systemPromptOptions: rawOptions },
        { cwd: craftedCwd },
      );
      expect(fallbackResult.systemPrompt).toContain(
        '<project_instructions path="AGENTS.md">\nUse <safe> & stable.\n</project_instructions>',
      );
      expect(fallbackResult.systemPrompt).not.toContain("&amp;lt;safe&amp;gt;");
      expect((fallbackResult.systemPrompt.match(/Current date:/g) ?? [])).toHaveLength(1);
      expect((fallbackResult.systemPrompt.match(/<cwd>/g) ?? [])).toHaveLength(1);
      expect(fallbackResult.systemPrompt).not.toContain("Current working directory:");
      expect(fallbackResult.systemPromptOptions.sections.env).toMatch(/^Current date: \d{4}-\d{2}-\d{2}$/);
      expect(rawOptions.contextFiles[0].content).toBe("Use <safe> & stable.");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it.each([undefined, "Custom preamble."])("preserves raw context for later extensions (custom=%s)", async (customPrompt) => {
    // Intent: encoding shared inputs must not make extension order change their meaning.
    // Pi 1.0 owns final context rendering, including its current verbatim XML interpolation.
    const root = await createTempWorkspace();
    const registry = createToolRegistry({ cwd: root });
    const initial = { path: "AGENTS.md", content: "Use <safe> & &lt;literal&gt;." };
    registry.pi.on("before_agent_start", (event: any) => {
      event.systemPromptOptions.contextFiles.push({ path: "before.md", content: "Before <context>." });
    });
    registerAgentSupport(registry.pi as never, { baseToolGuide: "" });
    registry.pi.on("before_agent_start", (event: any) => {
      expect(event.systemPromptOptions.contextFiles[0]).toEqual(initial);
      event.systemPromptOptions.contextFiles[0].content += "\nLater <context>.";
      event.systemPromptOptions.contextFiles.push({ path: 'rules"quoted.md', content: "</project_instructions><native-context>" });
    });
    const rawOptions = { cwd: root, customPrompt, contextFiles: [initial] };
    const result = await registry.emit("before_agent_start", { systemPromptOptions: rawOptions });
    const expected = [
      { path: initial.path, content: `${initial.content}\nLater <context>.` },
      { path: "before.md", content: "Before <context>." },
      { path: 'rules"quoted.md', content: "</project_instructions><native-context>" },
    ];
    expect(result.systemPromptOptions.contextFiles).toEqual(expected);
    expect(buildSystemPromptSections(result.systemPromptOptions).project_context).toBe(
      buildSystemPromptSections({ cwd: root, contextFiles: expected }).project_context,
    );
    expect(result.systemPrompt).not.toContain("&amp;lt;literal");
    expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();
    expect(rawOptions.contextFiles).toEqual([initial]);
  });

  it("omits disable-model-invocation skills from inherited agent prompt options", async () => {
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "skill-filter.md",
        `---
name: skill-filter
skills:
  - spec
  - hidden
---
`,
      );
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "skill-filter", { cwd: root });

      const specSkill = makeSkill("spec", "Visible");
      const hiddenSkill = makeSkill("hidden", "CLI only", { disableModelInvocation: true });
      const result = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: "Incoming prompt should be ignored.",
          systemPromptOptions: {
            cwd: root,
            customPrompt: "Default system prompt.",
            selectedTools: ["read"],
            skills: [specSkill, hiddenSkill],
          },
        },
        { cwd: root },
      );

      expect(result.systemPrompt).toContain("Default system prompt.");
      expect(result.systemPrompt).not.toContain("Incoming prompt should be ignored.");
      expect(result.systemPrompt).toContain("<name>spec</name>");
      expect(result.systemPrompt).not.toContain("<name>hidden</name>");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("filters native default prompt skills while retaining cwd with spaces exactly once", async () => {
    // Intent: without a custom prompt, upstream builds the default preamble and skill section.
    const root = await createTempWorkspace();
    const spacedCwd = join(root, "project with spaces");
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "skill-filter.md",
        `---
name: skill-filter
skills:
  - spec
---
`,
      );
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "skill-filter", { cwd: spacedCwd });

      const specSkill = makeSkill("spec", "Spec workflow");
      const otherSkill = makeSkill("other", "Other workflow");
      const rawOptions = {
        cwd: spacedCwd,
        selectedTools: ["read"],
        skills: [specSkill, otherSkill],
      };
      const result = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: buildSystemPrompt(rawOptions),
          systemPromptOptions: rawOptions,
        },
        { cwd: spacedCwd },
      );

      expect(buildSystemPromptSections(result.systemPromptOptions).preamble).toBe(buildSystemPromptSections(rawOptions).preamble);
      expect(result.systemPrompt).toContain("<name>spec</name>");
      expect(result.systemPrompt).not.toContain("<name>other</name>");
      expect((result.systemPrompt.match(/The following skills provide specialized instructions/g) ?? [])).toHaveLength(1);
      expect(result.systemPrompt).not.toContain(`\nCurrent working directory: ${spacedCwd}`);
      expect((result.systemPrompt.match(/<cwd>/g) ?? [])).toHaveLength(1);
      expect(result.systemPrompt).toContain(`<cwd>\n${spacedCwd}\n</cwd>`);
      expect(result.systemPrompt).not.toContain("**Your tool usage:**");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("filters native skills while retaining tool metadata, custom sections and addendum", async () => {
    // Intent: options mutation lets upstream rebuild dependent sections without losing
    // unrelated extension metadata or forcing a full prompt replacement.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(
        agentDir,
        "skill-filter.md",
        `---
name: skill-filter
skills:
  - spec
---
`,
      );
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "skill-filter", { cwd: root });

      const specSkill = makeSkill("spec", "Spec workflow");
      const otherSkill = makeSkill("other", "Other workflow");
      const rawOptions = {
        cwd: root,
        selectedTools: ["read"],
        skills: [specSkill, otherSkill],
        toolSnippets: { read: "Read a file" },
        toolGuidelines: { read: ["Keep reads targeted."] },
        promptGuidelines: ["Keep project conventions."],
        appendSystemPrompt: "Configured appendix.",
        sections: { project_rules: "Keep custom sections.", addendum: "Extension appendix." },
      };

      const result = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: buildSystemPrompt(rawOptions),
          systemPromptOptions: rawOptions,
        },
        { cwd: root },
      );

      const sections = buildSystemPromptSections(result.systemPromptOptions);
      expect(sections.preamble).toBe(buildSystemPromptSections(rawOptions).preamble);
      expect(sections.tools).toContain("- read: Read a file");
      expect(sections.rules).toContain("- Keep reads targeted.");
      expect(sections.rules).toContain("- Keep project conventions.");
      expect(sections.addendum).toBe("<addendum>\nExtension appendix.\n</addendum>");
      expect(result.systemPromptOptions.appendSystemPrompt).toBe("Configured appendix.");
      expect(result.systemPromptOptions.toolSnippets).toEqual(rawOptions.toolSnippets);
      expect(result.systemPromptOptions.toolGuidelines).toEqual(rawOptions.toolGuidelines);
      expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();
      expect((result.systemPrompt.match(/<name>spec<\/name>/g) ?? [])).toHaveLength(1);
      expect(result.systemPrompt).not.toContain("<name>other</name>");
      expect((result.systemPrompt.match(/The following skills provide specialized instructions/g) ?? [])).toHaveLength(1);
      expect(sections.skills).toContain("<skills>");
      expect((result.systemPrompt.match(/<cwd>/g) ?? [])).toHaveLength(1);
      expect(result.systemPrompt).toContain("<project_rules>\nKeep custom sections.\n</project_rules>");
      expect((result.systemPrompt.match(/<env>/g) ?? [])).toHaveLength(1);
      expect(result.systemPrompt).not.toContain("Current working directory:");
      expect(sections.cwd).toBe(`<cwd>\n${root.replace(/\\/g, "/")}\n</cwd>`);
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("omits native skill sections for an explicit empty allowlist", async () => {
    // Intent: an empty policy clears the skills input; upstream then omits its section.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(agentDir, "no-skills.md", `---\nname: no-skills\nskills: []\n---\n`);
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "no-skills", { cwd: root });

      const specSkill = makeSkill("spec", "Spec workflow");
      const rawOptions = { cwd: root, selectedTools: ["read"], skills: [specSkill] };

      const result = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: buildSystemPrompt(rawOptions),
          systemPromptOptions: rawOptions,
        },
        { cwd: root },
      );

      expect(buildSystemPromptSections(result.systemPromptOptions).preamble).toBe(buildSystemPromptSections(rawOptions).preamble);
      expect(result.systemPromptOptions.skills).toEqual([]);
      expect(result.systemPrompt).not.toContain("<skills>");
      expect(result.systemPrompt).not.toContain("<available_skills>");
      expect(result.systemPrompt).not.toContain("<name>spec</name>");
      expect((result.systemPrompt.match(/<cwd>/g) ?? [])).toHaveLength(1);
      expect((result.systemPrompt.match(/<env>/g) ?? [])).toHaveLength(1);
      expect(result.systemPrompt).toContain(`<cwd>\n${root.replace(/\\/g, "/")}\n</cwd>`);
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("keeps native skill sections when the agent inherits them", async () => {
    // Intent: omitting policy preserves skills; cwd stays separate from the date-only env.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(agentDir, "inherit-skills.md", `---\nname: inherit-skills\n---\n`);
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      await registry.runCommand("agent", "inherit-skills", { cwd: root });

      const specSkill = makeSkill("spec", "Spec workflow");
      const rawOptions = { cwd: root, selectedTools: ["read"], skills: [specSkill] };

      const result = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: buildSystemPrompt(rawOptions),
          systemPromptOptions: rawOptions,
        },
        { cwd: root },
      );

      expect(result.systemPrompt).toContain("<skills>");
      expect(result.systemPrompt).toContain("<name>spec</name>");
      expect((result.systemPrompt.match(/<cwd>/g) ?? [])).toHaveLength(1);
      expect((result.systemPrompt.match(/<env>/g) ?? [])).toHaveLength(1);
      expect(result.systemPrompt).toContain(`<cwd>\n${root.replace(/\\/g, "/")}\n</cwd>`);
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("does not leak skill policy across turns when switching from empty to inherited skills", async () => {
    // Intent: `skills: []` is an explicit empty policy, while an omitted field must keep Pi's
    // freshly loaded skill inputs on subsequent turns.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(agentDir, "no-skills.md", `---\nname: no-skills\nskills: []\n---\n`);
      await writeAgentFile(agentDir, "inherit-skills.md", `---\nname: inherit-skills\n---\n`);
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const specSkill = makeSkill("spec", "Spec workflow");
      const rawOptions = { cwd: root, selectedTools: ["read"], skills: [specSkill] };

      await registry.runCommand("agent", "no-skills", { cwd: root });
      const removed = await registry.emit(
        "before_agent_start",
        { systemPromptOptions: rawOptions },
        { cwd: root },
      );
      expect(removed.systemPrompt).not.toContain("<available_skills>");
      expect(removed.systemPrompt).not.toContain("<name>spec</name>");
      expect(rawOptions.skills).toEqual([specSkill]);

      await registry.runCommand("agent", "inherit-skills", { cwd: root });
      const inherited = await registry.emit(
        "before_agent_start",
        { systemPromptOptions: rawOptions },
        { cwd: root },
      );
      expect(inherited.systemPrompt).toContain("<available_skills>");
      expect(inherited.systemPrompt).toContain("<name>spec</name>");
      expect(inherited.systemPromptOptions.forceSystemPrompt).toBeUndefined();
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it("formats skills with bash when read is omitted and excludes them when neither tool is available", async () => {
    // Intent: Pi 1.0 allows reading skills via bash when read is absent, while agents with
    // neither read nor bash must omit available_skills entirely.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(agentDir, "bash-agent.md", `---\nname: bash-agent\ntools:\n  - bash\n---\n`);
      await writeAgentFile(agentDir, "edit-agent.md", `---\nname: edit-agent\ntools:\n  - edit\n---\n`);
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const specSkill = makeSkill("spec", "Spec workflow");

      await registry.runCommand("agent", "bash-agent", { cwd: root });
      const bashResult = await registry.emit(
        "before_agent_start",
        { systemPromptOptions: { cwd: root, selectedTools: ["read"], skills: [specSkill] } },
        { cwd: root },
      );
      expect(bashResult.systemPrompt).toContain("<available_skills>");
      expect(bashResult.systemPrompt).toContain("Use bash to load a skill's file");
      expect(bashResult.systemPromptOptions.selectedTools).toEqual(["bash"]);

      await registry.runCommand("agent", "edit-agent", { cwd: root });
      const editResult = await registry.emit(
        "before_agent_start",
        { systemPromptOptions: { cwd: root, selectedTools: ["read"], skills: [specSkill] } },
        { cwd: root },
      );
      expect(editResult.systemPrompt).not.toContain("<available_skills>");
      expect(editResult.systemPrompt).not.toContain("Use bash to load a skill's file");
      expect(editResult.systemPromptOptions.selectedTools).toEqual(["edit"]);
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  it.each(["default", "custom", "empty", "locked"])(
    "preserves preceding and following extension sections across %s agent turns",
    async (agentName) => {
      // Intent: all Agent prompt modes share Pi's mutable options. Earlier and later extensions
      // see the same state, and fresh turns/switches must not retain a prior Agent's policy.
      const root = await createTempWorkspace();
      const agentDir = await createTempWorkspace();
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        await writeAgentFile(agentDir, "custom.md", "---\nname: custom\n---\nAgent-owned preamble.\n");
        await writeAgentFile(agentDir, "empty.md", "---\nname: empty\n---\n");
        await writeAgentFile(agentDir, "locked.md", "---\nname: locked\ntools: [read]\nskills: [spec]\n---\n");
        const registry = createToolRegistry({ cwd: root });
        for (const name of ["read", "bash", "grep"]) registry.pi.registerTool({ name });
        registry.pi.setActiveTools(["read", "grep"]);

        let sharedOptions: unknown;
        registry.pi.on("before_agent_start", (event: any, ctx: any) => {
          sharedOptions = event.systemPromptOptions;
          event.systemPromptOptions.sections.before_extension = "Earlier extension.";
          expect(event.systemPrompt).toBe(ctx.getSystemPrompt());
          expect(event.systemPrompt).toContain("<before_extension>\nEarlier extension.\n</before_extension>");
        });
        registerAgentSupport(registry.pi as never, { baseToolGuide: "Pi-base tool guide." });
        registry.pi.on("before_agent_start", (event: any, ctx: any) => {
          expect(event.systemPromptOptions).toBe(sharedOptions);
          expect(event.systemPromptOptions.forceSystemPrompt).toBeUndefined();
          expect(event.systemPrompt).toContain("<pi_base_tools>\nPi-base tool guide.\n</pi_base_tools>");
          expect(event.systemPrompt).toBe(ctx.getSystemPrompt());
          event.systemPromptOptions.sections.after_extension = "Later extension.";
          expect(event.systemPrompt).toContain("<after_extension>\nLater extension.\n</after_extension>");
        });

        const spec = makeSkill("spec", "Visible spec");
        const other = makeSkill("other", "Other skill");
        // Test both native default preamble and SYSTEM.md-style custom preamble inheritance.
        for (const customPrompt of [undefined, "Pi-loaded preamble.", ""]) {
          const rawOptions = {
            cwd: root,
            customPrompt,
            selectedTools: ["bash"],
            skills: [spec, other],
            contextFiles: [{ path: "AGENTS.md", content: "Use <safe> & stable." }],
            appendSystemPrompt: "Configured appendix.",
            toolSnippets: { read: "Read snippet.", bash: "Bash snippet." },
            toolGuidelines: { read: ["Read guideline."], bash: ["Bash guideline."] },
            sections: { existing_extension: "Existing section." },
          };
          await registry.runCommand("agent", agentName, { cwd: root });
          const result = await registry.emit("before_agent_start", {
            systemPrompt: "Decoy rendered text must not become customPrompt.",
            systemPromptOptions: rawOptions,
          });
          const finalOptions = result.systemPromptOptions;
          const sections = buildSystemPromptSections(finalOptions);
          const expectedCustom = agentName === "custom" ? "Agent-owned preamble." : customPrompt;
          expect(finalOptions.customPrompt).toBe(expectedCustom);
          expect(sections.preamble).toBe(buildSystemPromptSections({ ...rawOptions, customPrompt: expectedCustom }).preamble);
          expect(finalOptions.selectedTools).toEqual(agentName === "locked" ? ["read"] : ["bash"]);
          expect(finalOptions.skills).toEqual(agentName === "locked" ? [spec] : [spec, other]);
          expect(sections.skills).toContain(agentName === "locked" ? "Use the read tool" : "Use bash");
          for (const [key, value] of Object.entries({
            existing_extension: "Existing section.",
            before_extension: "Earlier extension.",
            after_extension: "Later extension.",
            pi_base_tools: "Pi-base tool guide.",
            addendum: "Configured appendix.",
          })) expect(sections[key]).toBe(`<${key}>\n${value}\n</${key}>`);
          expect(finalOptions.forceSystemPrompt).toBeUndefined();
          expect(result.systemPrompt).toBe(buildSystemPrompt(finalOptions));
          expect(result.buildSystemPrompt()).toBe(result.systemPrompt);
          expect(result.systemPrompt).not.toContain("Decoy rendered text");
          expect(finalOptions.sections.env).toMatch(/^Current date: \d{4}-\d{2}-\d{2}$/);
          expect(sections.cwd).toBe(`<cwd>\n${root}\n</cwd>`);
          expect(sections.project_context).toContain("Use <safe> & stable.");
          if (!expectedCustom) {
            expect(sections.tools).toContain(agentName === "locked" ? "Read snippet." : "Bash snippet.");
            expect(sections.tools).not.toContain(agentName === "locked" ? "Bash snippet." : "Read snippet.");
            expect(sections.rules).toContain(agentName === "locked" ? "Read guideline." : "Bash guideline.");
            expect(sections.rules).not.toContain(agentName === "locked" ? "Bash guideline." : "Read guideline.");
          }
          // normalizeOptions clones caller collections; later turns start from raw, unescaped inputs.
          expect(rawOptions.sections).toEqual({ existing_extension: "Existing section." });
          expect(rawOptions.contextFiles[0].content).toBe("Use <safe> & stable.");
          expect(rawOptions.skills).toEqual([spec, other]);
          await registry.runCommand("agent", "default", { cwd: root });
          const restored = await registry.emit("before_agent_start", { systemPromptOptions: rawOptions });
          expect(restored.systemPromptOptions.customPrompt).toBe(customPrompt);
          expect(restored.systemPromptOptions.skills).toEqual([spec, other]);
          expect(restored.systemPromptOptions.selectedTools).toEqual(["bash"]);
          expect(restored.systemPrompt).not.toContain("Agent-owned preamble.");
        }
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    },
  );

  it.each([
    ["input", "Opaque prompt."],
    ["input", ""],
    ["before", "Opaque prompt."],
    ["before", ""],
    ["after", "Opaque prompt."],
    ["after", ""],
  ])("respects %s forceSystemPrompt, including %j", async (source, forcedPrompt) => {
    // Intent: a full replacement is an explicit opt-out from sections. Pi-base must not
    // clear it, and the helper must turn handler return values into forceSystemPrompt.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeAgentFile(agentDir, "custom.md", "---\nname: custom\n---\nAgent-owned preamble.\n");
      const registry = createToolRegistry({ cwd: root });
      const force = () => ({ systemPrompt: forcedPrompt });
      if (source === "before") registry.pi.on("before_agent_start", force);
      registerAgentSupport(registry.pi as never, { baseToolGuide: "Pi-base tool guide." });
      if (source === "after") registry.pi.on("before_agent_start", force);
      registry.pi.on("before_agent_start", (event: any, ctx: any) => {
        event.systemPromptOptions.sections.last_extension = "Must not override forced prompt.";
        expect(event.systemPromptOptions.forceSystemPrompt).toBe(forcedPrompt);
        expect(event.systemPrompt).toBe(forcedPrompt);
        expect(ctx.getSystemPrompt()).toBe(forcedPrompt);
      });
      await registry.runCommand("agent", "custom");
      const result = await registry.emit("before_agent_start", {
        systemPromptOptions: {
          cwd: root,
          customPrompt: "Configured preamble.",
          ...(source === "input" ? { forceSystemPrompt: forcedPrompt } : {}),
        },
      });
      expect(result.systemPromptOptions.customPrompt).toBe("Agent-owned preamble.");
      expect(result.systemPromptOptions.forceSystemPrompt).toBe(forcedPrompt);
      expect(result.systemPrompt).toBe(forcedPrompt);
      expect(result.buildSystemPrompt()).toBe(forcedPrompt);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("normalizes missing collections and default tools using Pi 1.0 rather than incoming prompt text", async () => {
    // Intent: catch mocks that sneak the old event.systemPrompt string into customPrompt,
    // or fail to expose the normalized collections before the first extension executes.
    const root = await createTempWorkspace();
    const registry = createToolRegistry({ cwd: root });
    registry.pi.on("before_agent_start", (event: any, ctx: any) => {
      expect(event.systemPromptOptions.customPrompt).toBeUndefined();
      expect(event.systemPromptOptions.selectedTools).toEqual(["read", "bash", "edit", "write"]);
      expect(event.systemPromptOptions.sections).toEqual({});
      expect(event.systemPromptOptions.toolSnippets).toEqual({});
      expect(event.systemPromptOptions.toolGuidelines).toEqual({});
      expect(event.systemPromptOptions.promptGuidelines).toEqual([]);
      expect(event.systemPromptOptions.skills).toEqual([]);
      expect(event.systemPromptOptions.contextFiles).toEqual([]);
      expect(event.systemPromptOptions.appendSystemPrompt).toBe("");
      expect(event.systemPrompt).toBe(buildSystemPrompt({ cwd: root }));
      expect(ctx.getSystemPrompt()).toBe(event.systemPrompt);
      return { message: { customType: "test", content: "Injected message.", display: false } };
    });
    const result = await registry.emit("before_agent_start", {
      systemPrompt: "Must not become a custom prompt.",
      systemPromptOptions: { cwd: root },
    });
    expect(result.messages).toEqual([{ customType: "test", content: "Injected message.", display: false }]);
    expect(result.systemPrompt).toBe(buildSystemPrompt({ cwd: root }));
    expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();
  });

  it("does not recurse forever through symlinked agent directories", async () => {
    // Intent: agent directories may contain symlinks; a symlink cycle must not
    // make catalog loading recurse until the process crashes.
    const agentDir = await createTempWorkspace();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await mkdir(join(agentDir, "agents"), { recursive: true });
      await symlink(join(agentDir, "agents"), join(agentDir, "agents", "self"));
      await writeAgentFile(agentDir, "simple.md", `---
name: simple
description: Simple agent
---

Simple prompt.
`);

      const registry = createToolRegistry();
      expect(() => piBaseExtension(registry.pi as any)).not.toThrow();
      await registry.runCommand("agent", "simple", {});
      expect(registry.getStatuses().get("00-pi-base-agent")).toContain("agent:simple");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });
});
