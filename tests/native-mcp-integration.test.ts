import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentSession, createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime,
  ProjectTrustStore, SessionManager, SettingsManager, VERSION,
  type Extension,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  createRealSubagentFactory, PI_BASE_MODULE_INSTANCE_MARKER, PI_BASE_MODULE_INSTANCE_TOKEN,
  type SubagentSession,
} from "../src/subagent/runner.js";

const fixture = fileURLToPath(new URL("./fixtures/native-mcp-server.mjs", import.meta.url));
const hooks = fileURLToPath(new URL("./fixtures/native-mcp-hooks.ts", import.meta.url));
const currentEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
const toolName = "mcp__fixture__echo";
let root: string;
let parent: AgentSession | undefined;
let child: SubagentSession | undefined;

async function records(path: string): Promise<Array<Record<string, unknown>>> {
  try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

afterEach(async () => {
  try {
    await child?.dispose();
    if (parent) {
      await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      parent.dispose();
    }
    if (root) {
      const pids = (await records(join(root, "server.jsonl"))).filter((r) => r.type === "start").map((r) => r.pid as number);
      await expect.poll(() => pids.every((pid) => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      }), { timeout: 5000 }).toBe(true);
    }
  } finally {
    child = undefined;
    parent = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function setup(projectTrusted = false, projectConfig = false) {
  expect(VERSION).toBe("0.99.1");
  root = await mkdtemp(join(tmpdir(), "pi-native-mcp-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("NATIVE_MCP_HOOK_LOG", join(root, "hooks.jsonl"));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [hooks], retry: { enabled: false } }));
  const config = {
    autoEnableCodemode: false,
    mcpServers: { fixture: { command: process.execPath, args: [fixture, join(root, "server.jsonl")], exposure: "direct" } },
  };
  await writeFile(join(projectConfig ? join(cwd, ".pi") : agentDir, "mcp.json"), JSON.stringify(config));
  new ProjectTrustStore(agentDir).set(cwd, projectTrusted);

  // Only the pi-base identity is a stand-in. Resource discovery, MCP, AgentSession,
  // model requests, nested dispatch, event hooks, transport and shutdown are all real.
  const getExtensions = DefaultResourceLoader.prototype.getExtensions;
  vi.spyOn(DefaultResourceLoader.prototype, "getExtensions").mockImplementation(function (this: DefaultResourceLoader) {
    const result = getExtensions.call(this);
    const extension = result.extensions.find((e) => resolve(e.resolvedPath) === resolve(hooks));
    if (extension) {
      extension.resolvedPath = currentEntry;
      const definition = extension.tools.get("task")!.definition;
      Object.defineProperty(definition, PI_BASE_MODULE_INSTANCE_MARKER, { value: PI_BASE_MODULE_INSTANCE_TOKEN, configurable: true });
    }
    return result;
  });
  const requests: TranscriptContext[] = [];
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: true, allowModelNetwork: false,
  });
  runtime.registerProvider("fixture", {
    api: "openai-completions", apiKey: "local-test-only", baseUrl: "http://invalid.local",
    models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      requests.push(structuredClone(context));
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const text = last?.role === "user"
        ? typeof last.content === "string" ? last.content
          : last.content.filter((c) => c.type === "text").map((c) => c.text).join("")
        : "";
      const call = text.startsWith("direct:") || text.startsWith("nested:");
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: call ? [{ type: "toolCall", id: `call-${requests.length}`,
          name: text.startsWith("nested:") ? "task" : toolName, arguments: { text: text.split(":")[1] } }]
          : [{ type: "text", text: "done" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      return stream;
    },
  });
  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.setProjectTrusted(new ProjectTrustStore(agentDir).get(cwd) === true);
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    extensionFactories: [{ name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true }],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  expect(resourceLoader.getExtensions().extensions.map((e: Extension) => e.resolvedPath)).toContain("builtin:mcp");
  const result = await createAgentSession({
    cwd, agentDir, resourceLoader, settingsManager, modelRuntime: runtime,
    model: runtime.getModel("fixture", "fake")!, sessionManager: SessionManager.inMemory(cwd),
  });
  parent = result.session;
  await parent.bindExtensions({});
  const ctx = parent.extensionRunner.createContext();
  return { cwd, agentDir, requests, ctx };
}

describe("official MCP in SDK subagents", () => {
  it("executes direct and nested calls with native declarations/hooks and independent parent/child connections", async () => {
    // Actual factory and provider loop prove that registered tools are active, not just constructed.
    const { ctx, requests } = await setup();
    await parent!.prompt("direct:parent");
    child = await createRealSubagentFactory().spawn({ ctx, agentType: "worker", childDepth: 1 });
    await child.prompt("direct:child");
    expect(child.collect()).toEqual({ report: "done", toolCount: 1 });
    // Inspect the child's provider request specifically, not just the parent's declaration.
    const childRequest = requests.find((r) => r.messages.some((m) => m.role === "user"
      && JSON.stringify(m.content).includes("direct:child")));
    expect(childRequest).toBeDefined();
    const declaration = childRequest!.messages.flatMap((m) => m.role === "system" ? m.toolsAdded ?? [] : [])
      .find((t) => t.name === toolName);
    expect(declaration).toMatchObject({
      name: toolName, description: expect.stringContaining("Echo fixture text"),
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    });
    expect(parent!.getActiveToolNames()).toContain(toolName);
    expect(child.view!.getToolDefinition(toolName)).toBeDefined();
    expect(child.view!.getToolDefinition("codemode")).toBeUndefined();
    expect(child.view!.getToolDefinition("tool_search")).toBeUndefined();
    expect(parent!.getAllTools().map((t) => t.name)).not.toContain("codemode");
    expect(parent!.getAllTools().map((t) => t.name)).not.toContain("tool_search");
    await child.prompt("nested:inner");
    expect(child.view!.getMessages().filter((m) => m.role === "toolResult").at(-1)).toMatchObject({
      toolName: "task", isError: false, content: [{ type: "text", text: "inner" }],
      details: { isError: false },
      nestedCalls: { complete: true, calls: [{ name: toolName, status: "ok" }] },
    });
    const events = await records(join(root, "hooks.jsonl"));
    expect(events.filter((e) => e.sessionId === child!.sessionId && e.name === toolName).map((e) => [e.type, e.parent !== undefined]))
      .toEqual([["tool_call", false], ["tool_result", false], ["tool_call", true], ["tool_result", true]]);
    const starts = (await records(join(root, "server.jsonl"))).filter((r) => r.type === "start");
    expect(starts).toHaveLength(2);
    const parentPid = starts[0].pid;
    const childPid = starts[1].pid;
    expect(childPid).not.toBe(parentPid);
    await child.dispose();
    await expect.poll(async () => (await records(join(root, "server.jsonl"))).some((r) => r.type === "exit" && r.pid === childPid)).toBe(true);
    expect((await records(join(root, "server.jsonl"))).some((r) => r.type === "exit" && r.pid === parentPid)).toBe(false);
    await parent!.prompt("direct:still-alive");
    expect((await records(join(root, "server.jsonl"))).some((r) => r.type === "call" && r.pid === parentPid && r.text === "still-alive")).toBe(true);
  });

  it("preserves MCP errors and aborts an in-flight child call before closing its connection", async () => {
    const { ctx } = await setup();
    await parent!.prompt("ready");
    child = await createRealSubagentFactory().spawn({ ctx, agentType: "worker", childDepth: 1 });
    await child.prompt("direct:fail");
    expect(child.view!.getMessages().find((m) => m.role === "toolResult")).toMatchObject({
      isError: true, content: [{ type: "text", text: "fixture failure" }],
    });
    const running = child.prompt("direct:wait");
    await expect.poll(async () => (await records(join(root, "server.jsonl"))).some((r) => r.type === "call" && r.text === "wait")).toBe(true);
    await child.abort();
    await running;
    expect(child.view!.getMessages().filter((m) => m.role === "toolResult").at(-1)).toMatchObject({ isError: true });
    await child.dispose();
    await parent!.prompt("direct:after-abort");
    expect((await records(join(root, "hooks.jsonl"))).filter((r) => r.sessionId === child!.sessionId && r.name === toolName).map((r) => r.type))
      .toEqual(["tool_call", "tool_result", "tool_call", "tool_result"]);
  });

  it("closes a connected child when startup fails after native extension binding", async () => {
    // Inject failure only after the real child has bound and called MCP, so cleanup must
    // release an actual stdio connection rather than merely dispose an empty SDK object.
    const { ctx } = await setup();
    await parent!.prompt("direct:parent");
    const bindExtensions = AgentSession.prototype.bindExtensions;
    vi.spyOn(AgentSession.prototype, "bindExtensions").mockImplementationOnce(async function (this: AgentSession, bindings) {
      await bindExtensions.call(this, bindings);
      await this.prompt("direct:binding-probe");
      throw new Error("injected post-binding failure");
    });
    await expect(createRealSubagentFactory().spawn({ ctx, agentType: "worker", childDepth: 1 }))
      .rejects.toThrow("injected post-binding failure");
    const starts = (await records(join(root, "server.jsonl"))).filter((r) => r.type === "start");
    expect(starts).toHaveLength(2);
    await expect.poll(async () => (await records(join(root, "server.jsonl")))
      .some((r) => r.type === "exit" && r.pid === starts[1].pid)).toBe(true);
    expect((await records(join(root, "server.jsonl"))).some((r) => r.type === "exit" && r.pid === starts[0].pid)).toBe(false);
    await parent!.prompt("direct:after-startup-failure");
    expect((await records(join(root, "server.jsonl"))).some((r) => r.type === "call" && r.text === "after-startup-failure")).toBe(true);
  });

  it.each([false, true])("honors official project mcp.json trust (trusted=%s)", async (trusted) => {
    const { ctx } = await setup(trusted, true);
    await parent!.prompt("ready");
    child = await createRealSubagentFactory().spawn({ ctx, agentType: "worker", childDepth: 1 });
    await child.prompt("ready");
    expect(parent!.getActiveToolNames().includes(toolName)).toBe(trusted);
    expect(child.view!.getToolDefinition(toolName) !== undefined).toBe(trusted);
    expect((await records(join(root, "server.jsonl"))).filter((r) => r.type === "start")).toHaveLength(trusted ? 2 : 0);
  });
});
