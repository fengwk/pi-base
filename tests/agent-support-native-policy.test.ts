import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolExposure } from "@earendil-works/pi-coding-agent";
import piBaseExtension from "../index.js";
import { AGENT_STATE_ENTRY, registerAgentSupport } from "../src/agent-support.js";
import { createTempWorkspace, createToolRegistry } from "./helpers.js";

describe("native agent tool policy", () => {
  let agentDir: string;
  let previousAgentDir: string | undefined;

  beforeEach(async () => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await createTempWorkspace();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(join(agentDir, "agents"));
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const writeAgent = async (name: string, fields: string) => {
    await writeFile(join(agentDir, "agents", `${name}.md`), `---\nname: ${name}\n${fields}\n---\n${name} prompt.\n`);
  };

  function harness(options: Omit<Parameters<typeof registerAgentSupport>[1], "baseToolGuide"> = {}) {
    const registry = createToolRegistry({ cwd: agentDir, model: { provider: "openai", id: "gpt-5" } });
    registerAgentSupport(registry.pi as never, { baseToolGuide: "", ...options });
    const register = (name: string, exposure: ToolExposure = "direct") => {
      registry.pi.registerTool({ name, exposure, execute: async () => ({ content: [] }) });
      // Pi auto-activates newly registered direct/model-only tools, not codemode/deferred/hidden.
      if (exposure === "direct" || exposure === "model-only") {
        registry.pi.setActiveTools([...new Set([...registry.getActiveTools(), name])]);
      }
    };
    const call = (toolName: string, nested = false) => registry.emit("tool_call", {
      type: "tool_call",
      toolName,
      toolCallId: nested ? "parent/1" : "call",
      ...(nested ? { parentToolCallId: "parent" } : {}),
      input: {},
    });
    const start = () => registry.emit("before_agent_start", {
      systemPrompt: "BASE",
      systemPromptOptions: { cwd: agentDir, selectedTools: registry.getActiveTools(), skills: [] },
    });
    return { registry, register, call, start };
  }

  it.each([false, true])("enforces the actual tool_call handler (nested=%s), even after manual activation", async (nested) => {
    // The parent id and active loadout must not grant a tool absent from an explicit policy.
    await writeAgent("reader", "tools: [read, codemode, hidden]");
    const { registry, register, call } = harness();
    register("read");
    register("bash");
    register("codemode", "codemode");
    register("hidden", "hidden");
    await registry.runCommand("agent", "reader");
    expect(registry.getActiveTools()).toEqual(["read"]);
    registry.pi.setActiveTools(["read", "bash", "hidden"]);
    expect(await call("read", nested)).toBeUndefined();
    expect(await call("codemode", nested)).toBeUndefined();
    for (const tool of ["bash", "hidden", "unknown"]) {
      expect(await call(tool, nested)).toEqual({
        block: true,
        reason: `Agent "reader" is not allowed to call tool "${tool}".`,
      });
    }
  });

  it("blocks real file mutation before execution even with YOLO permissions enabled", async () => {
    // Exercise the integrated execution pipeline, not only an independently queried policy helper.
    await writeAgent("reader", "tools: [read]");
    await mkdir(join(agentDir, ".pi"));
    await writeFile(join(agentDir, ".pi", "pi-base.json"), JSON.stringify({ yolo: true }));
    const path = join(agentDir, "protected.txt");
    await writeFile(path, "unchanged");
    const registry = createToolRegistry({ cwd: agentDir });
    piBaseExtension(registry.pi as never);
    await registry.emit("session_start", { reason: "startup" });
    await registry.runCommand("agent", "reader");
    expect(registry.getStatuses().get("01-pi-base-permission")).toBe("YOLO");
    const denied = await registry.getTool("write").execute(
      "write-call", { path, content: "mutated" }, undefined, undefined, { cwd: agentDir },
    );
    expect(denied).toMatchObject({
      isError: true,
      content: [{ type: "text", text: 'Error: Agent "reader" is not allowed to call tool "write".' }],
    });
    expect(await readFile(path, "utf8")).toBe("unchanged");
    const allowed = await registry.getTool("read").execute(
      "read-call", { path }, undefined, undefined, { cwd: agentDir },
    );
    expect(allowed.isError).not.toBe(true);
    expect(allowed.content).toEqual(expect.arrayContaining([expect.objectContaining({
      type: "text", text: expect.stringContaining("unchanged"),
    })]));
  });

  it("synchronizes late native discovery without exposing codemode/deferred or warning at startup", async () => {
    // Discovery completes asynchronously after session_start, just like native MCP's startup.
    await writeAgent("mcp-reader", "tools: [read, server_read, server_late, server_code, server_deferred, server_hidden]");
    const { registry, register, start, call } = harness();
    register("read");
    registry.pi.appendEntry(AGENT_STATE_ENTRY, { name: "mcp-reader" });
    await registry.emit("session_start", { reason: "startup" });
    expect(registry.getNotifications()).toEqual([]);
    expect(registry.getActiveTools()).toEqual(["read"]);
    await Promise.resolve().then(() => {
      register("server_read");
      register("server_denied");
      register("server_code", "codemode");
      register("server_deferred", "deferred");
      register("server_hidden", "hidden");
    });
    // The registry, rather than the pre-discovery prompt snapshot, determines the direct loadout.
    await registry.emit("before_agent_start", {
      systemPrompt: "BASE",
      systemPromptOptions: { cwd: agentDir, selectedTools: ["read"], skills: [] },
    });
    expect(registry.getActiveTools()).toEqual(["read", "server_read"]);
    expect(await call("server_read")).toBeUndefined();
    expect(await call("server_code", true)).toBeUndefined();
    expect(await call("server_deferred", true)).toBeUndefined();
    expect(await call("server_denied", true)).toMatchObject({ block: true });
    expect(await call("server_hidden", true)).toMatchObject({ block: true });
    expect(registry.getNotifications()).toEqual([]);

    // Discovery after the first prompt's native startup timeout is picked up next turn too.
    register("server_late");
    register("server_denied_again");
    registry.pi.registerTool({ name: "server_read", exposure: "hidden" });
    await registry.emit("turn_start", {});
    expect(registry.getActiveTools()).toEqual(["read", "server_late"]);
    expect(await call("server_late")).toBeUndefined();
    expect(await call("server_read", true)).toMatchObject({ block: true });
    await start();
    expect(registry.getActiveTools()).toEqual(["read", "server_late"]);
  });

  it.each(["codemode", "deferred"] as const)("retains allowed %s tools loaded by native tool_search, but removes denied/hidden tools", async (exposure) => {
    // Native tool_search activates discovered tools; the next turn must keep that allowed load,
    // without promoting registered-but-unloaded tools or trusting a denied tool's active status.
    await writeAgent("searcher", "tools: [tool_search, server_loaded, server_unloaded]");
    const { registry, register, call, start } = harness();
    register("tool_search");
    register("server_loaded", exposure);
    register("server_unloaded", exposure);
    register("server_denied", exposure);
    await registry.runCommand("agent", "searcher");
    expect(registry.getActiveTools()).toEqual(["tool_search"]);
    expect(await call("tool_search")).toBeUndefined();

    // Simulate tool_search loading both an allowed and a denied result into the native loadout.
    registry.pi.setActiveTools([...registry.getActiveTools(), "server_loaded", "server_denied"]);
    expect(await call("server_loaded")).toBeUndefined();
    expect(await call("server_denied")).toMatchObject({ block: true });
    expect(await call("server_denied", true)).toMatchObject({ block: true });
    await registry.emit("turn_start", {});
    expect(registry.getActiveTools()).toEqual(["tool_search", "server_loaded"]);
    expect(await call("server_loaded")).toBeUndefined();
    expect(await call("server_loaded", true)).toBeUndefined();
    await start();
    await registry.emit("model_select", { model: { provider: "other", id: "other-model" } });
    expect(registry.getActiveTools()).toEqual(["tool_search", "server_loaded"]);

    // A later native withdrawal re-registers the definition as hidden, even if it was active.
    registry.pi.registerTool({ name: "server_loaded", exposure: "hidden" });
    expect(await call("server_loaded")).toMatchObject({ block: true });
    expect(await call("server_loaded", true)).toMatchObject({ block: true });
    await registry.emit("turn_start", {});
    expect(registry.getActiveTools()).toEqual(["tool_search"]);
  });

  it("switches policy immediately and preserves an implicit agent's manual direct loadout", async () => {
    // Implicit capability checks use registered tools, not the user-reduced active declaration set.
    await writeAgent("reader", "tools: [read]");
    await writeAgent("writer", "tools: [bash]");
    const { registry, register, call, start } = harness();
    register("read");
    register("bash");
    for (const name of ["edit", "write", "apply_patch"]) register(name);
    register("server_code", "codemode");
    await registry.runCommand("agent", "reader");
    expect(await call("bash", true)).toMatchObject({ block: true });
    await registry.runCommand("agent", "writer");
    expect(await call("read", true)).toMatchObject({ block: true });
    expect(await call("bash", true)).toBeUndefined();
    await registry.runCommand("agent", "default");
    registry.pi.setActiveTools(["read"]);
    await start();
    await registry.emit("turn_start", {});
    expect(registry.getActiveTools()).toEqual(["read"]);
    expect(await call("bash", true)).toBeUndefined();
    expect(await call("server_code", true)).toBeUndefined();
    expect(await call("edit", true)).toBeUndefined();
    expect(await call("apply_patch")).toBeUndefined();
    expect(await call("unknown", true)).toMatchObject({ block: true });
  });

  it.each([false, true])("enforces task subagents/maxDepth and runtime-owned goals (nested=%s)", async (nested) => {
    // Depth and goals are runtime capabilities, recomputed at execution rather than cached active tools.
    await writeAgent("parent", "tools: [read]\nsubagents: [child]");
    await writeAgent("child", "tools: [read, task]");
    let depth = 0;
    let goalActive = false;
    const { registry, register, call, start } = harness({
      subagentControls: {
        taskToolName: "task", getMaxDepth: () => 1, getMaxTurns: () => 10, readDepth: () => depth,
      },
      runtimeOwnedToolNames: ["create_goal", "get_goal", "update_goal"],
      getInjectedToolNames: (explicit) => goalActive ? ["get_goal", "update_goal"] : explicit ? [] : ["create_goal"],
    });
    for (const name of ["read", "task", "create_goal", "get_goal", "update_goal"]) register(name);
    await registry.runCommand("agent", "parent");
    expect(registry.getActiveTools()).toEqual(["read", "task"]);
    expect(await call("task", nested)).toBeUndefined();
    expect(await call("create_goal", nested)).toMatchObject({ block: true });
    goalActive = true;
    expect(await call("get_goal", nested)).toBeUndefined();
    expect(await call("update_goal", nested)).toBeUndefined();
    depth = 1;
    expect(await call("task", nested)).toMatchObject({ block: true });
    await start();
    expect(registry.getActiveTools()).toEqual(["read", "get_goal", "update_goal"]);
    depth = 0;
    await registry.runCommand("agent", "child");
    expect(await call("task", nested)).toMatchObject({ block: true });
    await registry.runCommand("agent", "default");
    goalActive = false;
    expect(await call("create_goal", nested)).toBeUndefined();
    expect(await call("get_goal", nested)).toMatchObject({ block: true });
    expect(await call("task", nested)).toMatchObject({ block: true });
  });

  it("keeps model routing authoritative for execution and blocks nested model-only tools", async () => {
    // Projected edit/write capability must not re-enable the obsolete representation at execution.
    await writeAgent("editor", "tools: [edit, write, model_only]");
    const { registry, register, call } = harness();
    for (const name of ["edit", "write", "apply_patch"]) register(name);
    register("model_only", "model-only");
    await registry.runCommand("agent", "editor");
    expect(registry.getActiveTools()).toEqual(["apply_patch", "model_only"]);
    expect(await call("apply_patch", true)).toBeUndefined();
    expect(await call("edit", true)).toMatchObject({ block: true });
    expect(await call("write")).toMatchObject({ block: true });
    expect(await call("model_only")).toBeUndefined();
    expect(await call("model_only", true)).toMatchObject({ block: true });
    await registry.emit("model_select", { model: { provider: "other", id: "other-model" } });
    expect(registry.getActiveTools()).toEqual(["edit", "write", "model_only"]);
    expect(await call("edit", true)).toBeUndefined();
    expect(await call("apply_patch", true)).toMatchObject({ block: true });
  });
});
