import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, VERSION,
  type AgentSession, type ExtensionError, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Tool, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import piBaseExtension from "../index.js";
import { AGENT_STATE_ENTRY } from "../src/agent-support.js";
import { loadRuntimePiBaseSettings, reloadRuntimePiBaseSettings } from "../src/runtime-settings.js";

const nativeTool = "mcp__fixture__echo";
const nestedTool = "fixture_nested";
const serverFixture = fileURLToPath(new URL("./fixtures/native-mcp-server.mjs", import.meta.url));
let root: string | undefined;
let session: AgentSession | undefined;

interface ServerRecord {
  pid: number;
  type: string;
  text?: string;
}

async function serverRecords(): Promise<ServerRecord[]> {
  try {
    return (await readFile(join(root!, "server.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function serverCalls(): Promise<string[]> {
  return (await serverRecords()).filter((record) => record.type === "call").map((record) => record.text!);
}

function toolDeclarations(request: TranscriptContext) {
  const tools = new Map<string, Tool>();
  for (const message of request.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

function latestToolResult() {
  const result = session!.messages.filter((message) => message.role === "toolResult").at(-1);
  expect(result).toBeDefined();
  return result!;
}

afterEach(async () => {
  try {
    if (session) {
      await session.abort();
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session.dispose();
      }
    }
    if (root) {
      const pids = (await serverRecords()).filter((record) => record.type === "start").map((record) => record.pid);
      await expect.poll(() => pids.every((pid) => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      }), { timeout: 5000 }).toBe(true);
    }
  } finally {
    session = undefined;
    reloadRuntimePiBaseSettings();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

async function setup(options: { initialAgent?: string; permissionDeny?: boolean } = {}) {
  expect(VERSION).toBe("1.0.0");
  root = await mkdtemp(join(tmpdir(), "pi-native-mcp-policy-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(join(agentDir, "agents"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_BASE_GLOBAL_SETTINGS_PATH", join(agentDir, "pi-base.json"));
  await writeFile(join(agentDir, "pi-base.json"), JSON.stringify({
    yolo: false,
    notify: { agentEnd: false, permissionAsked: false },
    ...(options.permissionDeny ? { permission: { [nativeTool]: "deny" } } : {}),
  }));
  for (const [name, tools] of [
    ["allowed", [nativeTool, nestedTool]],
    ["empty", []],
    ["nested-only", [nestedTool]],
  ] as const) {
    await writeFile(join(agentDir, "agents", `${name}.md`),
      `---\nname: ${name}\ntools: ${JSON.stringify(tools)}\n---\nLocal policy integration agent.\n`);
  }
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
    autoEnableCodemode: false,
    mcpServers: { fixture: {
      command: process.execPath, args: [serverFixture, join(root, "server.jsonl")], exposure: "direct",
    } },
  }));

  const requests: TranscriptContext[] = [];
  const extensionErrors: ExtensionError[] = [];
  const beforeAgentTools: string[][] = [];
  const nestedAttempts: string[] = [];
  const probe = { forceLoadout: false };
  const fixtureExtension: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: nestedTool, label: "Nested MCP fixture", description: "Call the native echo tool through ctx.executeTool.",
      parameters: Type.Object({ text: Type.String() }),
      async execute(_id, args, _signal, _update, ctx) {
        nestedAttempts.push(args.text);
        const outcome = await ctx.executeTool(nativeTool, args);
        return { ...outcome.result, details: { nestedIsError: outcome.isError } };
      },
    });
    // Deliberately re-activate disallowed tools through the public API, as another extension
    // could do. This makes refusal prove pi-base's execution guard, not "tool not found".
    // Register after pi-base so its allowlist projection has already run.
    pi.on("before_agent_start", () => {
      beforeAgentTools.push([...pi.getActiveTools()]);
      if (probe.forceLoadout) pi.setActiveTools([nativeTool, nestedTool]);
    });
    pi.on("turn_start", () => {
      if (probe.forceLoadout) pi.setActiveTools([nativeTool, nestedTool]);
    });
  };
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: true, allowModelNetwork: false,
  });
  runtime.registerProvider("policy-fixture", {
    api: "openai-completions", apiKey: "local-test-only", baseUrl: "http://invalid.local",
    models: [{
      id: "fake", name: "Fake", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      requests.push(structuredClone(context));
      const last = context.messages.filter((message) => message.role !== "system").at(-1);
      const text = last?.role === "user"
        ? typeof last.content === "string" ? last.content
          : last.content.filter((part) => part.type === "text").map((part) => part.text).join("")
        : "";
      // Emit the requested call even when not declared, modelling a stale/malicious response.
      const call = /^(direct|nested):/.test(text);
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: call ? [{
          type: "toolCall", id: `policy-call-${requests.length}`,
          name: text.startsWith("direct:") ? nativeTool : nestedTool,
          arguments: { text: text.slice(text.indexOf(":") + 1) },
        }] : [{ type: "text", text: "done" }],
        stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      return stream;
    },
  });
  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.setProjectTrusted(false);
  settingsManager.applyOverrides({ retry: { enabled: false }, compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noContextFiles: true, noSkills: true, noPromptTemplates: true,
    extensionFactories: [
      { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
      { name: "pi-base", factory: piBaseExtension },
      { name: "policy-fixture", factory: fixtureExtension },
    ],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const manager = SessionManager.inMemory(cwd);
  manager.appendCustomEntry(AGENT_STATE_ENTRY, { name: options.initialAgent ?? "allowed" });
  const result = await createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader, modelRuntime: runtime,
    model: runtime.getModel("policy-fixture", "fake")!, sessionManager: manager,
  });
  session = result.session;
  session.extensionRunner.onError((error) => extensionErrors.push(error));
  await session.bindExtensions({});
  return { cwd, requests, extensionErrors, beforeAgentTools, nestedAttempts, probe };
}

describe("native MCP with the real pi-base agent and permission policy", () => {
  it("keeps async native discovery active for the explicit agent's first model request and executes direct/nested calls", async () => {
    // No MCP-ready polling: the first prompt must wait for native startup, then pi-base must
    // synchronize the explicit allowlist without filtering the builtin-sourced MCP tool.
    const { requests, extensionErrors, beforeAgentTools, nestedAttempts } = await setup();
    await session!.prompt("direct:first");
    expect(beforeAgentTools[0]).toEqual([nativeTool, nestedTool]);
    expect(toolDeclarations(requests[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: nativeTool, description: expect.stringContaining("Echo fixture text"),
        parameters: expect.objectContaining({ type: "object", required: ["text"], properties: { text: { type: "string" } } }),
      }),
      expect.objectContaining({ name: nestedTool }),
    ]));
    expect(session!.getAllTools().find((tool) => tool.name === nativeTool)?.sourceInfo?.source).toBe("builtin");
    expect(latestToolResult()).toMatchObject({ toolName: nativeTool, isError: false, content: [{ type: "text", text: "first" }] });
    await session!.prompt("nested:inner");
    expect(latestToolResult()).toMatchObject({
      toolName: nestedTool, isError: false, content: [{ type: "text", text: "inner" }],
      details: { nestedIsError: false }, nestedCalls: { complete: true, calls: [{ name: nativeTool, status: "ok" }] },
    });
    expect(nestedAttempts).toEqual(["inner"]);
    expect(await serverCalls()).toEqual(["first", "inner"]);
    expect(extensionErrors).toEqual([]);
  });

  it.each([false, true])("enforces switched empty/nested-only allowlists even with runtime reactivation (YOLO=%s)", async (yolo) => {
    const { cwd, requests, extensionErrors, nestedAttempts, probe } = await setup();
    await session!.prompt("direct:allowed-before");
    if (yolo) await session!.prompt("/yolo");
    expect(loadRuntimePiBaseSettings(cwd).settings.yolo).toBe(yolo);
    await session!.prompt("/agent empty");
    await session!.prompt("ready");
    expect(session!.getActiveToolNames()).toEqual([]);
    expect(toolDeclarations(requests.at(-1)!)).toEqual([]);
    probe.forceLoadout = true;
    await session!.prompt("direct:blocked-empty");
    expect(latestToolResult()).toMatchObject({
      isError: true, content: [{ type: "text", text: expect.stringContaining(`Agent "empty" is not allowed to call tool "${nativeTool}"`) }],
    });
    await session!.prompt("nested:blocked-outer");
    expect(latestToolResult()).toMatchObject({
      isError: true, content: [{ type: "text", text: expect.stringContaining(`Agent "empty" is not allowed to call tool "${nestedTool}"`) }],
    });
    expect(nestedAttempts).toEqual([]);
    expect(await serverCalls()).toEqual(["allowed-before"]);

    // Allow the outer tool but not MCP, then force MCP callable to exercise the nested policy
    // guard itself. Its refusal must be recorded, not accidentally pass via an inactive tool.
    await session!.prompt("/agent nested-only");
    await session!.prompt("nested:blocked-inner");
    expect(latestToolResult()).toMatchObject({
      details: { nestedIsError: true },
      content: [{ type: "text", text: expect.stringContaining(`Agent "nested-only" is not allowed to call tool "${nativeTool}"`) }],
      nestedCalls: { complete: true, calls: [{ name: nativeTool, status: "error" }] },
    });
    expect(nestedAttempts).toEqual(["blocked-inner"]);
    expect(await serverCalls()).toEqual(["allowed-before"]);

    probe.forceLoadout = false;
    await session!.prompt("/agent allowed");
    await session!.prompt("direct:allowed-after");
    await session!.prompt("nested:allowed-inner-after");
    expect(latestToolResult()).toMatchObject({ isError: false, details: { nestedIsError: false } });
    expect(await serverCalls()).toEqual(["allowed-before", "allowed-after", "allowed-inner-after"]);
    expect(extensionErrors).toEqual([]);
  });

  it("blocks native direct/nested calls by permission after switching to an allowed agent", async () => {
    const { requests, extensionErrors, nestedAttempts } = await setup({ initialAgent: "empty", permissionDeny: true });
    await session!.prompt("ready");
    await session!.prompt("/agent allowed");
    await session!.prompt("direct:permission-blocked");
    expect(toolDeclarations(requests.at(-2)!)).toEqual(expect.arrayContaining([expect.objectContaining({ name: nativeTool })]));
    expect(latestToolResult()).toMatchObject({
      isError: true, content: [{ type: "text", text: expect.stringContaining(`Permission denied for ${nativeTool}`) }],
    });
    await session!.prompt("nested:permission-blocked-inner");
    expect(latestToolResult()).toMatchObject({
      details: { nestedIsError: true },
      content: [{ type: "text", text: expect.stringContaining(`Permission denied for ${nativeTool}`) }],
      nestedCalls: { complete: true, calls: [{ name: nativeTool, status: "error" }] },
    });
    expect(nestedAttempts).toEqual(["permission-blocked-inner"]);
    expect((await serverRecords()).filter((record) => record.type === "start")).toHaveLength(1);
    expect(await serverCalls()).toEqual([]);
    // YOLO bypasses permission only; the preceding test independently proves it cannot bypass
    // agent policy. This positive control also proves the permission refusals used a live tool.
    await session!.prompt("/yolo");
    await session!.prompt("direct:permission-bypassed");
    expect(latestToolResult()).toMatchObject({ isError: false });
    expect(await serverCalls()).toEqual(["permission-bypassed"]);
    expect(extensionErrors).toEqual([]);
  });
});
