import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { AGENT_STATE_ENTRY } from "../src/agent-support.js";
import { DEPTH_ENTRY, ROOT_SESSION_ENTRY } from "../src/subagent/depth.js";
import { isApplyPatchPreferredModelId, projectFileMutationTools } from "../src/model-tool-routing.js";
import { createTempWorkspace, createToolRegistry } from "./helpers.js";

const GPT5 = { provider: "openai", id: "gpt-5.3-codex" };
const GPT4 = { provider: "openai", id: "gpt-4.1" };
const GPT_OSS = { provider: "openai", id: "gpt-oss-120b" };
const ANTHROPIC = { provider: "anthropic", id: "claude-sonnet-4-5" };

function fileTools(tools: readonly string[]): string[] {
  return tools.filter((tool) => ["edit", "write", "apply_patch"].includes(tool));
}

async function writeAgent(agentDir: string, name: string, body: string): Promise<void> {
  const dir = join(agentDir, "agents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), body, "utf8");
}

let previousAgentDir: string | undefined;
let previousGlobalSettingsPath: string | undefined;

beforeEach(async () => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  previousGlobalSettingsPath = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  const configRoot = await createTempWorkspace();
  const globalPath = join(configRoot, "global.json");
  await writeFile(globalPath, "{}", "utf8");
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalPath;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousGlobalSettingsPath === undefined) delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  else process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
});

describe("model tool routing", () => {
  it("matches the centralized OpenCode model policy and capability projection", () => {
    // Intent: every lifecycle path uses this one pure policy, including case-insensitive exclusions.
    expect(isApplyPatchPreferredModelId("GPT-5.3-CODEX")).toBe(true);
    expect(isApplyPatchPreferredModelId("openai/gpt-5-mini")).toBe(true);
    expect(isApplyPatchPreferredModelId("namespace/GPT-5.3-CODEX")).toBe(true);
    expect(isApplyPatchPreferredModelId("namespace/gpt-4.1")).toBe(false);
    expect(isApplyPatchPreferredModelId("namespace/gpt-5-oss-codex")).toBe(false);
    expect(isApplyPatchPreferredModelId(GPT4.id)).toBe(false);
    expect(isApplyPatchPreferredModelId(GPT_OSS.id)).toBe(false);
    expect(isApplyPatchPreferredModelId(ANTHROPIC.id)).toBe(false);
    expect(isApplyPatchPreferredModelId(undefined)).toBe(false);

    expect(projectFileMutationTools(["read", "edit", "write", "apply_patch"], GPT5.id, "implicit"))
      .toEqual(["read", "apply_patch"]);
    expect(projectFileMutationTools(["read", "edit", "write", "apply_patch"], GPT4.id, "implicit"))
      .toEqual(["read", "edit", "write"]);
    expect(projectFileMutationTools(["read", "apply_patch", "grep"], GPT4.id, "implicit"))
      .toEqual(["read", "edit", "write", "grep"]);
    expect(projectFileMutationTools(["read", "write", "grep"], GPT5.id, "implicit"))
      .toEqual(["read", "write", "grep"]);
    expect(projectFileMutationTools(["read", "edit", "grep"], GPT5.id, "implicit"))
      .toEqual(["read", "edit", "grep"]);
    expect(projectFileMutationTools(["read", "grep"], GPT5.id, "implicit"))
      .toEqual(["read", "grep"]);
    expect(projectFileMutationTools(["read", "edit", "write"], GPT5.id, "explicit"))
      .toEqual(["read", "apply_patch"]);
    expect(projectFileMutationTools(["read", "edit"], GPT5.id, "explicit")).toEqual(["read", "edit"]);
    expect(projectFileMutationTools(["read", "write"], GPT5.id, "explicit")).toEqual(["read", "write"]);
    expect(projectFileMutationTools(["read"], GPT5.id, "explicit")).toEqual(["read"]);
    expect(projectFileMutationTools(["read", "apply_patch"], ANTHROPIC.id, "explicit"))
      .toEqual(["read", "apply_patch"]);
  });

  it.each([
    ["GPT-5/Codex", GPT5, ["apply_patch"]],
    ["GPT-4", GPT4, ["edit", "write"]],
    ["GPT-OSS", GPT_OSS, ["edit", "write"]],
    ["Anthropic", ANTHROPIC, ["edit", "write"]],
    ["no model", undefined, ["edit", "write"]],
  ] as const)("routes implicit startup tools for %s", async (_name, model, expected) => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry(model ? { model } : {});
    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root, model });

    expect(registry.getTool("edit")).toBeDefined();
    expect(registry.getTool("write")).toBeDefined();
    expect(registry.getTool("apply_patch")).toBeDefined();
    expect(fileTools(registry.getActiveTools())).toEqual(expected);
  });

  it("replaces stale file tools in a non-empty preserved session set in both directions", async () => {
    // Intent: resumed default sessions replace a stale full mutation representation,
    // preserve unrelated tools, and do not broaden an edit-only reduced capability.
    const root = await createTempWorkspace();

    const gpt = createToolRegistry({ model: GPT5 });
    piBaseExtension(gpt.pi as any);
    gpt.pi.setActiveTools(["read", "edit", "write", "grep"]);
    await gpt.emit("session_start", { reason: "resume" }, { cwd: root, model: GPT5 });
    expect(gpt.getActiveTools()).toEqual(["read", "apply_patch", "grep"]);

    const reduced = createToolRegistry({ model: GPT5 });
    piBaseExtension(reduced.pi as any);
    reduced.pi.setActiveTools(["read", "edit", "grep"]);
    await reduced.emit("session_start", { reason: "resume" }, { cwd: root, model: GPT5 });
    expect(reduced.getActiveTools()).toEqual(["read", "edit", "grep"]);

    const anthropic = createToolRegistry({ model: ANTHROPIC });
    piBaseExtension(anthropic.pi as any);
    anthropic.pi.setActiveTools(["read", "apply_patch", "grep"]);
    await anthropic.emit("session_start", { reason: "resume" }, { cwd: root, model: ANTHROPIC });
    expect(anthropic.getActiveTools()).toEqual(["read", "edit", "write", "grep"]);
  });

  it("projects only the current implicit capability on manual model changes", async () => {
    // Intent: a model switch must not rebuild the default agent from all registered
    // tools, because that would undo the user's disabled bash/non-file choices or
    // grant file mutation after the user disabled every file tool.
    const root = await createTempWorkspace();
    const registry = createToolRegistry({ model: ANTHROPIC, models: [GPT5] });
    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root, model: ANTHROPIC });

    registry.pi.setActiveTools(["read", "grep", "edit"]);
    await registry.emit("model_select", { type: "model_select", model: GPT5, previousModel: ANTHROPIC, source: "set" }, { cwd: root, model: GPT5 });
    expect(registry.getActiveTools()).toEqual(["read", "grep", "edit"]);
    expect(registry.getActiveTools()).not.toContain("bash");

    await registry.emit("model_select", { type: "model_select", model: ANTHROPIC, previousModel: GPT5, source: "set" }, { cwd: root, model: ANTHROPIC });
    expect(registry.getActiveTools()).toEqual(["read", "grep", "edit"]);
    registry.pi.setActiveTools(["read", "grep", "edit", "write"]);
    await registry.emit("model_select", { type: "model_select", model: GPT5, previousModel: ANTHROPIC, source: "set" }, { cwd: root, model: GPT5 });
    expect(registry.getActiveTools()).toEqual(["read", "grep", "apply_patch"]);
    await registry.emit("model_select", { type: "model_select", model: ANTHROPIC, previousModel: GPT5, source: "set" }, { cwd: root, model: ANTHROPIC });
    expect(registry.getActiveTools()).toEqual(["read", "grep", "edit", "write"]);
    expect(registry.getActiveTools()).not.toContain("bash");

    registry.pi.setActiveTools(["read", "grep"]);
    await registry.emit("model_select", { type: "model_select", model: GPT5, previousModel: ANTHROPIC, source: "set" }, { cwd: root, model: GPT5 });
    expect(registry.getActiveTools()).toEqual(["read", "grep"]);
    await registry.emit("model_select", { type: "model_select", model: ANTHROPIC, previousModel: GPT5, source: "set" }, { cwd: root, model: ANTHROPIC });
    expect(registry.getActiveTools()).toEqual(["read", "grep"]);
  });

  it("projects explicit agent tools on model activation without granting absent edit capability", async () => {
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeAgent(agentDir, "legacy-editor", `---\nname: legacy-editor\nmodel: ${GPT5.provider}/${GPT5.id}\ntools: [read, edit, write]\n---\nEditor.`);
    await writeAgent(agentDir, "patch-any", `---\nname: patch-any\nmodel: ${ANTHROPIC.provider}/${ANTHROPIC.id}\ntools: [read, apply_patch]\n---\nPatch.`);
    await writeAgent(agentDir, "reader", `---\nname: reader\nmodel: ${GPT5.provider}/${GPT5.id}\ntools: [read]\n---\nReader.`);
    const registry = createToolRegistry({ model: ANTHROPIC, models: [GPT5, ANTHROPIC] });
    piBaseExtension(registry.pi as any);

    await registry.runCommand("agent", "legacy-editor", { cwd: root, model: ANTHROPIC });
    expect(fileTools(registry.getActiveTools())).toEqual(["apply_patch"]);

    await registry.runCommand("agent", "patch-any", { cwd: root, model: GPT5 });
    expect(fileTools(registry.getActiveTools())).toEqual(["apply_patch"]);

    await registry.runCommand("agent", "reader", { cwd: root, model: ANTHROPIC });
    expect(fileTools(registry.getActiveTools())).toEqual([]);
  });

  it("reprojects an active explicit agent without broadening an edit-only allowlist", async () => {
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeAgent(agentDir, "editor", "---\nname: editor\ntools: [read, edit]\n---\nEditor.");
    const registry = createToolRegistry({ model: ANTHROPIC, models: [GPT5] });
    piBaseExtension(registry.pi as any);
    await registry.runCommand("agent", "editor", { cwd: root, model: ANTHROPIC });
    expect(fileTools(registry.getActiveTools())).toEqual(["edit"]);

    await registry.emit("model_select", { type: "model_select", model: GPT5, previousModel: ANTHROPIC, source: "set" }, { cwd: root, model: GPT5 });
    expect(fileTools(registry.getActiveTools())).toEqual(["edit"]);

    await registry.emit("model_select", { type: "model_select", model: ANTHROPIC, previousModel: GPT5, source: "set" }, { cwd: root, model: ANTHROPIC });
    expect(fileTools(registry.getActiveTools())).toEqual(["edit"]);
  });

  it("recomputes routing for resumed agents and subagent session startup", async () => {
    // Intent: persisted child/root agent state must project against the session model, not stale parent tools.
    const root = await createTempWorkspace();
    const agentDir = await createTempWorkspace();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeAgent(agentDir, "editor", "---\nname: editor\ntools: [read, edit, write]\n---\nEditor.");

    const resumed = createToolRegistry({ model: GPT5 });
    resumed.pi.appendEntry(AGENT_STATE_ENTRY, { name: "editor" });
    piBaseExtension(resumed.pi as any);
    await resumed.emit("session_start", { reason: "resume" }, { cwd: root, model: GPT5 });
    expect(fileTools(resumed.getActiveTools())).toEqual(["apply_patch"]);

    const subagent = createToolRegistry({ model: GPT5, hasUI: false });
    subagent.pi.appendEntry(AGENT_STATE_ENTRY, { name: "editor" });
    subagent.pi.appendEntry(DEPTH_ENTRY, { depth: 2 });
    subagent.pi.appendEntry(ROOT_SESSION_ENTRY, { rootSessionId: "root-session" });
    piBaseExtension(subagent.pi as any);
    await subagent.emit("session_start", { reason: "startup" }, { cwd: root, model: GPT5, hasUI: false });
    expect(fileTools(subagent.getActiveTools())).toEqual(["apply_patch"]);
  });
});
