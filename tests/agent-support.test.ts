import { mkdir, writeFile } from "node:fs/promises";
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

function makeSkill(name: string, description: string): Skill {
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
    disableModelInvocation: false,
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
      expect(registry.getStatuses().get("pi-base-agent")).toBeUndefined();

      await registry.runCommand("agent", "planner", { cwd: root });
      expect(registry.getActiveTools()).toEqual(["read", "grep"]);
      expect(registry.getCurrentModel()).toEqual(plannerModel);
      expect(registry.pi.getThinkingLevel()).toBe("high");
      expect(registry.getStatuses().get("pi-base-agent")).toContain("agent:planner");

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
      expect(plannerPrompt.systemPrompt).toContain("Base Tool Usage Guidance");

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
      expect(registry.getStatuses().get("pi-base-agent")).toBeUndefined();

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
      expect(defaultPrompt.systemPrompt).toContain("Base Tool Usage Guidance");
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
});
