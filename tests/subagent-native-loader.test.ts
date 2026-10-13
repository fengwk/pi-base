import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultResourceLoader, ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  createRealSubagentFactory, PI_BASE_MODULE_INSTANCE_MARKER, PI_BASE_MODULE_INSTANCE_TOKEN,
  type SubagentSession,
} from "../src/subagent/runner.js";

const hooks = fileURLToPath(new URL("./fixtures/native-mcp-hooks.ts", import.meta.url));
const server = fileURLToPath(new URL("./fixtures/native-mcp-server.mjs", import.meta.url));
const currentEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
const toolName = "mcp__fixture__echo";
let root: string | undefined;
let child: SubagentSession | undefined;

afterEach(async () => {
  try {
    await child?.dispose();
    if (root) {
      let records: Array<{ type: string; pid: number }> = [];
      try {
        records = (await readFile(join(root, "server.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const pids = records.filter((record) => record.type === "start").map((record) => record.pid);
      await expect.poll(() => pids.every((pid) => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      }), { timeout: 5000 }).toBe(true);
    }
  } finally {
    child = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe("subagent native builtin configuration", () => {
  it.each([
    { disabled: ["tool-search"], codemode: true, search: false, mcp: true },
    { disabled: ["codemode"], codemode: false, search: true, mcp: true },
    { disabled: ["mcp"], codemode: true, search: true, mcp: false },
    { disabled: ["codemode", "tool-search"], codemode: false, search: false, mcp: true },
  ])("uses real loader settings: disabled=$disabled", async ({ disabled, codemode, search, mcp }) => {
    // Only persistent pi-base identity is a stand-in. Factory, settings, loader, SDK
    // session, MCP transport and tool execution are real; provider is deterministic/offline.
    root = await mkdtemp(join(tmpdir(), "pi-subagent-builtins-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    await mkdir(cwd);
    await mkdir(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("NATIVE_MCP_HOOK_LOG", join(root, "hooks.jsonl"));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      extensions: [hooks, ...disabled.map((name) => `-builtin:${name}`)],
      defaultTools: ["+codemode"],
      retry: { enabled: false }, compaction: { enabled: false },
    }));
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
      autoEnableCodemode: false,
      mcpServers: { fixture: { command: process.execPath, args: [server, join(root, "server.jsonl")], exposure: "direct" } },
    }));
    const paths: string[] = [];
    const getExtensions = DefaultResourceLoader.prototype.getExtensions;
    vi.spyOn(DefaultResourceLoader.prototype, "getExtensions").mockImplementation(function (this: DefaultResourceLoader) {
      const result = getExtensions.call(this);
      expect(result.errors).toEqual([]);
      paths.splice(0, paths.length, ...result.extensions.map((extension) => extension.resolvedPath));
      const identity = result.extensions.find((extension) => resolve(extension.resolvedPath) === resolve(hooks));
      if (identity) {
        identity.resolvedPath = currentEntry;
        Object.defineProperty(identity.tools.get("task")!.definition, PI_BASE_MODULE_INSTANCE_MARKER, {
          value: PI_BASE_MODULE_INSTANCE_TOKEN, configurable: true,
        });
      }
      return result;
    });
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"),
      refreshOnCreate: true, allowModelNetwork: false,
    });
    const requests: TranscriptContext[] = [];
    runtime.registerProvider("fixture", {
      api: "openai-completions", apiKey: "local-test-only", baseUrl: "http://invalid.local",
      models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        requests.push(structuredClone(context));
        const call = mcp && context.messages.at(-1)?.role === "user";
        const viaCodemode = call && JSON.stringify(context.messages.at(-1)).includes("probe-codemode");
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: call ? [{ type: "toolCall", id: viaCodemode ? "codemode-call" : "direct-call",
            name: viaCodemode ? "codemode" : toolName,
            arguments: viaCodemode ? { code: `return await tools.${toolName}({ text: "native-codemode" });` }
              : { text: "native-direct" } }]
            : [{ type: "text", text: "done" }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: call ? "toolUse" : "stop", timestamp: 1,
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
        return stream;
      },
    });
    child = await createRealSubagentFactory().spawn({
      ctx: {
        cwd, model: runtime.getModel("fixture", "fake"), modelRegistry: { runtime },
        isProjectTrusted: () => false,
        sessionManager: { getSessionId: () => "root", getEntries: () => [] },
      } as never,
      agentType: "worker", childDepth: 1,
    });
    await child.prompt("probe");
    const declared = requests[0].messages.flatMap((message) => message.role === "system" ? message.toolsAdded ?? [] : []);
    expect(declared.some((tool) => tool.name === "codemode")).toBe(codemode);
    expect(declared.some((tool) => tool.name === toolName)).toBe(mcp);
    expect(declared.some((tool) => tool.name === "tool_search")).toBe(false);
    expect(child.view!.getToolDefinition("codemode") !== undefined).toBe(codemode);
    expect(child.view!.getToolDefinition("tool_search") !== undefined).toBe(search);
    expect(child.view!.getToolDefinition(toolName) !== undefined).toBe(mcp);
    for (const [name, enabled] of [["codemode", codemode], ["tool-search", search], ["mcp", mcp]] as const) {
      expect(paths.includes(`builtin:${name}`)).toBe(enabled);
    }
    expect(paths.filter((path) => path.startsWith("builtin:"))).toEqual(
      ["codemode", "tool-search", "mcp"].filter((name) => !disabled.includes(name)).map((name) => `builtin:${name}`),
    );
    if (mcp) {
      expect(child.view!.getMessages().find((message) => message.role === "toolResult")).toMatchObject({
        toolName, isError: false, content: [{ type: "text", text: "native-direct" }],
      });
    } else {
      await expect(readFile(join(root, "server.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(child.collect()).toEqual({ report: "done", toolCount: mcp ? 1 : 0 });
    if (mcp && codemode) {
      // Registration alone is insufficient: execute the enabled sandbox against direct MCP.
      await child.prompt("probe-codemode");
      const result = child.view!.getMessages().filter((message) => message.role === "toolResult").at(-1);
      expect(result).toMatchObject({ toolName: "codemode", isError: false });
      expect(JSON.stringify(result?.content)).toContain("native-codemode");
      const records = (await readFile(join(root, "server.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(records.filter((record) => record.type === "call").map((record) => record.text))
        .toEqual(["native-direct", "native-codemode"]);
      expect(child.collect()).toEqual({ report: "done", toolCount: 2 });
    }
  });
});
