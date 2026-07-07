import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import piBaseExtension from "../index.js";
import { createTempWorkspace, createToolRegistry } from "./helpers.js";

const BASE_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "bash",
  "edit",
  "write",
  "lsp_diagnostics",
  "lsp_goto_definition",
  "lsp_workspace_symbols",
  "lsp_java_decompile",
] as const;

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

describe("agent support", () => {
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
      expect(plannerPrompt.systemPrompt).toContain("Appendix");
      expect(plannerPrompt.systemPrompt).toContain("<name>spec</name>");
      expect(plannerPrompt.systemPrompt).not.toContain("<name>other</name>");
      expect(plannerPrompt.systemPrompt).toContain(`Current working directory: ${root}`);
      expect(plannerPrompt.systemPrompt).toContain("# Core Tool Rules");

      await registry.pi.setModel(defaultModel as any);
      registry.setThinkingLevel("off");
      registry.pi.setActiveTools(["bash"]);
      await registry.emit("session_start", { reason: "reload" }, { cwd: root });
      expect(registry.getCurrentModel()).toEqual(plannerModel);
      expect(registry.getActiveTools()).toEqual(["read", "grep"]);
      expect(registry.pi.getThinkingLevel()).toBe("high");

      await registry.runCommand("agent", "default", { cwd: root });
      expect(registry.getCurrentModel()).toEqual(defaultModel);
      expect(registry.getActiveTools()).toEqual(BASE_TOOL_NAMES.slice());
      expect(registry.pi.getThinkingLevel()).toBe("medium");
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
      expect(defaultPrompt.systemPrompt).toContain("# Core Tool Rules");
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
      expect(r1.getActiveTools()).toEqual(["read", "grep"]);

      // Case 2: unknown --agent name falls back to the default agent without throwing.
      const r2 = createToolRegistry({ model: defaultModel, models: [defaultModel, plannerModel] });
      r2.setFlag("agent", "does-not-exist");
      piBaseExtension(r2.pi as any);
      await r2.emit("session_start", { reason: "startup" }, { cwd: root });
      expect(r2.getStatuses().get("00-pi-base-agent")).toContain("agent:default");

      // Case 3: a session that already persisted an agent ignores the flag (resume semantics).
      const r3 = createToolRegistry({ model: defaultModel, models: [defaultModel, plannerModel] });
      r3.setFlag("agent", "planner");
      piBaseExtension(r3.pi as any);
      r3.pi.appendEntry("pi-base-agent-state", { name: "default" });
      await r3.emit("session_start", { reason: "startup" }, { cwd: root });
      expect(r3.getStatuses().get("00-pi-base-agent")).toContain("agent:default");
      expect(r3.getActiveTools()).not.toEqual(["read", "grep"]);
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

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('field "tools" must be an array of strings'));

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
      expect(registry.getActiveTools()).toEqual(BASE_TOOL_NAMES.slice());
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
description: ${longDescription}
---

Verbose prompt.
`,
      );
      await writeAgentFile(
        agentDir,
        "verbose-copy.md",
        `---
name: verbose-copy
description: ${longDescription}
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
        message: 'Agent "missing-model": model missing-provider/missing-model not found. Check the provider name, model ID, and enabled models configuration.',
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
        message: 'Agent "broken-model": failed to activate model provider-b/model-b. Check the provider, model ID, and auth configuration.',
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
        message: 'Agent "broken-thinking": failed to apply thinking level high. Check the selected model and provider configuration.',
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

  it("reports unexpected activation errors without crashing the /agent command", async () => {
    // Intent: unexpected internal failures must be surfaced as direct command
    // errors instead of bubbling out as `Extension \"command:agent\" error`.
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
        message: 'Agent "broken-tools": activation failed: Cannot read properties of undefined (reading \'models\')',
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

  it("rebuilds empty-body agent prompts from structured options instead of patching the incoming prompt", async () => {
    // Intent: empty-body agents should inherit the Pi-loaded custom prompt and
    // let pi-base rebuild the full prompt from structured options. The incoming
    // rendered prompt string is no longer the source of truth.
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
      expect(filtered.systemPrompt).toContain("# Project Context");
      expect(filtered.systemPrompt).toContain(`## ${join(root, "AGENTS.md")}`);
      expect(filtered.systemPrompt).toContain("<name>spec</name>");
      expect(filtered.systemPrompt).not.toContain("<name>other</name>");
      expect(filtered.systemPrompt).toContain("# Core Tool Rules");

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

  it("omits disable-model-invocation skills when rebuilding inherited agent prompts", async () => {
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

  it("falls back to Pi's prebuilt prompt when no custom prompt source exists", async () => {
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

      const result = await registry.emit(
        "before_agent_start",
        {
          systemPrompt: "Pi fallback prompt.",
          systemPromptOptions: {
            cwd: root,
            selectedTools: ["read"],
            skills: [makeSkill("spec", "Spec workflow")],
          },
        },
        { cwd: root },
      );

      expect(result.systemPrompt).toContain("Pi fallback prompt.");
      expect(result.systemPrompt).not.toContain("<name>spec</name>");
      expect(result.systemPrompt).toContain("# Core Tool Rules");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
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
