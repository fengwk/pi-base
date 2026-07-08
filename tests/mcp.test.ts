import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import piBaseExtension from "../index.js";
import { createMcpManager } from "../src/mcp/manager.js";
import { createMcpToolDefinition } from "../src/mcp/adapter.js";
import type { McpClientFactory, McpProtocolClient, McpTool, McpToolCallResult } from "../src/mcp/types.js";
import { convertJsonSchemaToTypeBox } from "../src/mcp/schema.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

async function writeProjectSettings(root: string, settings: unknown): Promise<void> {
  const settingsDir = join(root, ".pi");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(join(settingsDir, "pi-base.json"), JSON.stringify(settings), "utf8");
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for MCP state");
}

function hasTool(registry: ReturnType<typeof createToolRegistry>, name: string): boolean {
  try {
    registry.getTool(name);
    return true;
  } catch {
    return false;
  }
}

interface FakeClientStep {
  connectDelayMs?: number;
  connectError?: string;
  tools?: McpTool[];
  toolsSequence?: McpTool[][];
  callResult?: (name: string, args: Record<string, unknown>) => McpToolCallResult;
}

class FakeMcpClient implements McpProtocolClient {
  private connected = false;
  private listToolsCalls = 0;

  constructor(private readonly step: FakeClientStep) {}

  async connect(_timeoutMs: number): Promise<void> {
    if (this.step.connectDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.step.connectDelayMs));
    }
    if (this.step.connectError) throw new Error(this.step.connectError);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.connected) throw new Error("MCP client is not connected.");
    if (this.step.toolsSequence) {
      const index = Math.min(this.listToolsCalls, this.step.toolsSequence.length - 1);
      this.listToolsCalls += 1;
      return this.step.toolsSequence[index] ?? [];
    }
    return this.step.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>, _options?: { signal?: AbortSignal }): Promise<McpToolCallResult> {
    if (!this.connected) throw new Error("MCP client is not connected.");
    if (this.step.callResult) return this.step.callResult(name, args);
    return { content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }] };
  }

  isConnected(): boolean {
    return this.connected;
  }
}

function createClientFactory(stepsByServer: Record<string, FakeClientStep[]>): McpClientFactory {
  return (serverKey) => {
    const steps = stepsByServer[serverKey] ?? [];
    const next = steps.length > 1 ? steps.shift() : steps[0];
    if (!next) throw new Error(`No fake MCP client scripted for ${serverKey}`);
    return new FakeMcpClient(next);
  };
}

let previousGlobalSettingsPath: string | undefined;
const registries: Array<ReturnType<typeof createToolRegistry>> = [];


beforeEach(async () => {
  previousGlobalSettingsPath = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  const root = await createTempWorkspace();
  const globalPath = join(root, "global-pi-base.json");
  await writeFile(globalPath, JSON.stringify({}), "utf8");
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalPath;
});

afterEach(async () => {
  while (registries.length > 0) {
    const registry = registries.pop();
    if (registry) {
      await registry.emit("session_shutdown", {});
    }
  }
  if (previousGlobalSettingsPath === undefined) {
    delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  } else {
    process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
  }
});

const echoTool: McpTool = {
  name: "echo",
  description: "Echo input text",
  inputSchema: {
    type: "object",
    description: "Echo input arguments.",
    properties: {
      text: {
        type: "string",
        description: "Text to echo back.",
      },
    },
    required: ["text"],
  },
};
const noArgTool: McpTool = {
  name: "create_temp_dir",
  description: "Create a temporary directory",
  inputSchema: {
    type: "object",
    properties: {},
  },
};
function createMcpRegistry(options: Parameters<typeof createToolRegistry>[0]): ReturnType<typeof createToolRegistry> {
  const registry = createToolRegistry(options);
  registries.push(registry);
  return registry;
}

describe("mcp support", () => {
  it("registers MCP tools with an empty prefix and updates the MCP status line", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
            toolPrefix: "",
          },
        },
      },
    });

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({
          mm: [{
            tools: [echoTool],
            callResult: (_name, args) => ({
              content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }],
            }),
          }],
        }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 1/1 servers" && hasTool(registry, "echo"));

    const result = await registry.getTool("echo").execute("1", { text: "hello" }, undefined, undefined, { cwd: root });
    expect(getText(result)).toContain("echo:hello");
    expect(registry.getStatuses().get("02-pi-base-mcp")).toBe("MCP: 1/1 servers");
    const parameters = registry.getTool("echo").parameters as { description?: string; properties?: Record<string, { description?: string }> };
    expect(parameters.description).toBe("Echo input arguments.");
    expect(parameters.properties?.text?.description).toBe("Text to echo back.");
    const callComponent = registry.getTool("echo").renderCall?.({ text: "hello" }, {}, { lastComponent: undefined });
    const callText = (callComponent?.render(120).join("\n") ?? "").trimEnd();
    expect(callText).toContain('"text": "hello"');
  });
  it("renders MCP results with collapsed truncation and full expansion", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      render: {
        collapsedToolResultMaxChars: {
          "e*o": 20,
        },
      },
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
            toolPrefix: "",
          },
        },
      },
    });

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({ mm: [{ tools: [echoTool] }] }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => hasTool(registry, "echo"));

    const tool = registry.getTool("echo");
    const longLine = "x".repeat(200);
    const multiLine = Array.from({ length: 25 }, () => longLine).join("\n");
    const renderContext = {
      args: { text: "hello" },
      toolCallId: "1",
      invalidate() {},
      state: {},
      cwd: root,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      lastComponent: undefined,
    };

    const collapsedComponent = tool.renderResult?.({
      content: [{ type: "text", text: multiLine }],
    } as any, { expanded: false, isPartial: false }, {}, renderContext as any);
    const collapsedText = (collapsedComponent?.render(120).join("\n") ?? "").trimEnd();
    expect(collapsedText).toContain("ctrl+o to expand");
    expect(collapsedText).not.toContain(multiLine);
    expect(collapsedText).toContain("output truncated");
    // The character budget is applied before counting lines, so a 20-char cap collapses the
    // 25-line body to a single truncated line: content stays visible, no line-overflow hint.
    expect(collapsedText).toContain("xxxxxxxxxxxxxxxxxxxx");
    expect(collapsedText).not.toContain("more lines");

    const expandedComponent = tool.renderResult?.({
      content: [{ type: "text", text: multiLine }],
    } as any, { expanded: true, isPartial: false }, {}, { ...renderContext, expanded: true } as any);
    const expandedText = (expandedComponent?.render(20000).join("\n") ?? "").trimEnd();
    expect(expandedText).toContain(longLine);
    expect(expandedText).not.toContain("ctrl+o to expand");
  });
  it("omits an empty JSON block for no-argument MCP tools", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
            toolPrefix: "",
          },
        },
      },
    });

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({ mm: [{ tools: [noArgTool] }] }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => hasTool(registry, "create_temp_dir"));

    const callComponent = registry.getTool("create_temp_dir").renderCall?.({}, {}, { lastComponent: undefined });
    const callText = (callComponent?.render(120).join("\n") ?? "").trimEnd();
    expect(callText).toContain("create_temp_dir");
    expect(callText).not.toContain("{}");
  });

  it("renders streaming call state for MCP tools", () => {
    const definition = createMcpToolDefinition({
      serverKey: "docs",
      serverConfig: { type: "local", command: ["demo"], toolPrefix: "docs" } as any,
      tool: {
        name: "search",
        description: "Search docs",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });

    const component = definition.renderCall?.(
      { query: "hello" },
      {} as any,
      {
        lastComponent: undefined,
        argsComplete: false,
        expanded: false,
        state: {},
        cwd: process.cwd(),
      } as any,
    );

    const rendered = component?.render(200).join("\n") ?? "";
    expect(rendered).not.toContain("<missing-");
    expect(rendered).toContain("\"query\": \"hello\"");
  });

  it("uses the server key as the default tool prefix", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
          },
        },
      },
    });

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({ mm: [{ tools: [echoTool] }] }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => hasTool(registry, "mm_echo"));

    expect(hasTool(registry, "echo")).toBe(false);
    expect(hasTool(registry, "mm_echo")).toBe(true);
  });
  it("keeps MCP registration idempotent when session_start is emitted twice on the same registry", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
            toolPrefix: "",
          },
        },
      },
    });

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({ mm: [{ tools: [echoTool] }] }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 1/1 servers" && hasTool(registry, "echo"));

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 1/1 servers");

    await registry.runCommand("mcp-status", "", { cwd: root });
    const message = String(registry.getMessages().at(-1)?.content ?? "");
    expect(message).toContain("MCP: 1/1 servers");
    expect(message).toContain("echo");
    expect(message).not.toContain("[conflict");

    const result = await registry.getTool("echo").execute("1", { text: "hello" }, undefined, undefined, { cwd: root });
    expect(getText(result)).toContain("echo:");
  });

  it("does not report its own MCP tools as conflicts after shutdown and restart", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
            toolPrefix: "",
          },
        },
      },
    });

    const updatedEchoTool: McpTool = {
      ...echoTool,
      description: "Echo input text v2",
    };
    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({
          mm: [
            { tools: [echoTool] },
            { tools: [updatedEchoTool] },
          ],
        }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 1/1 servers" && hasTool(registry, "echo"));
    expect(registry.getTool("echo").description).toBe("Echo input text");

    await registry.emit("session_shutdown", { reason: "quit" }, { cwd: root });
    await registry.emit("session_start", { reason: "resume" }, { cwd: root });
    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 1/1 servers" && registry.getTool("echo").description === "Echo input text v2");

    await registry.runCommand("mcp-status", "", { cwd: root });
    const message = String(registry.getMessages().at(-1)?.content ?? "");
    expect(message).toContain("echo");
    expect(message).not.toContain("[conflict");
  });

  it("reloads MCP config and transfers aliases owned by removed pi-base servers", async () => {
    // Intent: /reload must rebuild MCP from fresh settings, and a tool alias
    // previously registered by pi-base should be overwriteable when the owning
    // server key disappears from the new config.
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          old: {
            type: "local",
            command: ["mock-mcp-old"],
            toolPrefix: "",
          },
        },
      },
    });

    const newEchoTool: McpTool = {
      ...echoTool,
      description: "Echo input text from new server",
    };
    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({
          old: [{
            tools: [echoTool],
            callResult: () => ({ content: [{ type: "text", text: "old-server" }] }),
          }],
          next: [{
            tools: [newEchoTool],
            callResult: () => ({ content: [{ type: "text", text: "new-server" }] }),
          }],
        }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 1/1 servers" && registry.getTool("echo").description === "Echo input text");
    const firstResult = await registry.getTool("echo").execute("1", { text: "hello" }, undefined, undefined, { cwd: root });
    expect(getText(firstResult)).toContain("old-server");

    await writeProjectSettings(root, {
      mcp: {
        servers: {
          next: {
            type: "local",
            command: ["mock-mcp-next"],
            toolPrefix: "",
          },
        },
      },
    });
    await registry.emit("session_start", { reason: "reload" }, { cwd: root });
    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 1/1 servers" && registry.getTool("echo").description === "Echo input text from new server");

    const result = await registry.getTool("echo").execute("2", { text: "hello" }, undefined, undefined, { cwd: root });
    expect(getText(result)).toContain("new-server");
    await registry.runCommand("mcp-status", "", { cwd: root });
    expect(String(registry.getMessages().at(-1)?.content ?? "")).not.toContain("[conflict");
  });

  it("marks tools stale when heartbeat discovers that the server removed them", async () => {
    // Intent: MCP servers can change their advertised tools over time; pi-base
    // should preserve visibility in /mcp-status instead of silently pretending
    // the old tool is still fresh.
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
            toolPrefix: "",
          },
        },
      },
    });

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({
          mm: [{
            toolsSequence: [
              [echoTool, noArgTool],
              [echoTool],
            ],
          }],
        }),
        heartbeatIntervalMs: 20,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => hasTool(registry, "echo") && hasTool(registry, "create_temp_dir"));
    const deadline = Date.now() + 1_000;
    let message = "";
    while (Date.now() < deadline) {
      await registry.runCommand("mcp-status", "", { cwd: root });
      message = String(registry.getMessages().at(-1)?.content ?? "");
      if (message.includes("create_temp_dir [stale]")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(message).toContain("create_temp_dir [stale]");
  });

  it("removes stale tool aliases from the active-tools set so the model cannot pick a dead alias", async () => {
    // Intent: a tool the server stops advertising must not linger in active tools,
    // otherwise the model can select an alias that only fails at execution time.
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
            toolPrefix: "",
          },
        },
      },
    });

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({
          mm: [{
            toolsSequence: [
              [echoTool, noArgTool],
              [echoTool],
            ],
          }],
        }),
        heartbeatIntervalMs: 20,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => registry.getActiveTools().includes("echo") && registry.getActiveTools().includes("create_temp_dir"));

    // Once the heartbeat sees create_temp_dir removed it must drop from active tools
    // while the still-advertised echo alias stays selectable.
    await waitFor(() => !registry.getActiveTools().includes("create_temp_dir"));
    expect(registry.getActiveTools()).toContain("echo");

    // Tearing MCP down must retire the remaining alias instead of leaving a dead entry.
    await registry.emit("session_shutdown", {});
    expect(registry.getActiveTools()).not.toContain("echo");
  });

  it("does not re-activate MCP aliases excluded by the active agent's tool allowlist", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
            toolPrefix: "",
          },
        },
      },
    });
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await createTempWorkspace();
    const defaultModel = { provider: "provider-a", id: "model-a" };
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: defaultModel.provider, defaultModel: defaultModel.id, defaultThinkingLevel: "medium" }),
        "utf8",
      );
      await writeFile(join(agentDir, "SYSTEM.md"), "Default system prompt.", "utf8");
      await mkdir(join(agentDir, "agents"), { recursive: true });
      await writeFile(
        join(agentDir, "agents", "reviewer.md"),
        `---\nname: reviewer\ntools:\n  - read\n---\nReview only.\n`,
        "utf8",
      );

      const registry = createMcpRegistry({ hasUI: true, cwd: root, model: defaultModel, models: [defaultModel] });
      registry.setFlag("agent", "reviewer");
      piBaseExtension(registry.pi as any, {
        mcp: {
          clientFactory: createClientFactory({ mm: [{ toolsSequence: [[echoTool], [echoTool], [echoTool]] }] }),
          heartbeatIntervalMs: 20,
          retryDelaysMs: [20],
          callWaitTimeoutMs: 20,
        },
      });

      await registry.emit("session_start", { reason: "startup" }, { cwd: root });
      await waitFor(() => hasTool(registry, "echo"));
      expect(registry.getActiveTools()).toEqual(["read"]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(registry.getActiveTools()).toEqual(["read"]);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("converts JSON Schema type arrays into MCP parameter unions", () => {
    const unionSchema: any = convertJsonSchemaToTypeBox({ type: ["string", "null"] });
    expect(Array.isArray(unionSchema.anyOf)).toBe(true);
    expect(unionSchema.anyOf).toHaveLength(2);
    expect(unionSchema.anyOf.map((entry: any) => entry.type)).toEqual(expect.arrayContaining(["string", "null"]));

    const definition = createMcpToolDefinition({
      serverKey: "mm",
      serverConfig: { type: "local", command: ["mock-mcp"] },
      tool: {
        name: "maybe_text",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: ["string", "null"] },
          },
        },
      },
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const propertySchema = (definition.parameters as any).properties.text;
    expect(Array.isArray(propertySchema.anyOf)).toBe(true);
    expect(propertySchema.anyOf.map((entry: any) => entry.type)).toEqual(expect.arrayContaining(["string", "null"]));
  });

  it("shows MCP on the second footer line while keeping YOLO on the first line", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      yolo: true,
      contextCompression: { anchorHygiene: true },
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
          },
        },
      },
    });
    await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true } }), "utf8");

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({ mm: [{ tools: [echoTool] }] }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 1/1 servers");

    const footerLines = registry.renderFooter(120);
    expect(footerLines.length).toBeGreaterThanOrEqual(3);
    expect(footerLines.at(-1) ?? "").toContain("agent:default");
    expect((footerLines.at(-1) ?? "").indexOf("agent:default")).toBe(0);
    expect(footerLines.at(-1) ?? "").toContain("YOLO");
    expect(footerLines.at(-1) ?? "").toContain("MCP: 1/1 servers");
  });

  it("shows a connecting suffix while MCP servers are still starting", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
          },
        },
      },
    });

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({ mm: [{ connectDelayMs: 100, tools: [echoTool] }] }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 0/1 servers connecting");
    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 1/1 servers");
  });

  it("shows a failed suffix after a connection attempt fails", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
          },
        },
      },
    });

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({ mm: [{ connectError: "missing credentials" }] }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [1_000],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 0/1 servers connection failed");
  });
  it("treats MCP status UI updates as best-effort", async () => {
    const manager = createMcpManager({
      loadSettings: () => ({ settings: { mcp: { servers: {} } } } as any),
      onSnapshotChange: () => {
        throw new Error("stale ctx");
      },
    });

    const pi = {
      registerTool() {},
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
    };
    const ctx = { cwd: await createTempWorkspace() };

    await expect(manager.start(ctx as any, pi as any)).resolves.toBeUndefined();
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  it("retries failed MCP connections until the server becomes available", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
          },
        },
      },
    });

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({
          mm: [
            { connectError: "mock server is still starting" },
            { tools: [echoTool] },
          ],
        }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 1/1 servers" && hasTool(registry, "mm_echo"), 1_500);

    expect(registry.getStatuses().get("02-pi-base-mcp")).toBe("MCP: 1/1 servers");
  });

  it("reconnects after a recoverable MCP tool-call transport error", async () => {
    // Intent: MCP transports can close between heartbeat checks; a tool-call
    // socket error should trigger reconnect so the next call can recover.
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
            toolPrefix: "",
          },
        },
      },
    });

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({
          mm: [
            {
              tools: [echoTool],
              callResult: () => {
                throw new Error("socket closed");
              },
            },
            {
              tools: [echoTool],
              callResult: (_name, args) => ({
                content: [{ type: "text", text: `recovered:${String(args.text ?? "")}` }],
              }),
            },
          ],
        }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => hasTool(registry, "echo"));

    const failed = await registry.getTool("echo").execute("1", { text: "hello" }, undefined, undefined, { cwd: root });
    expect(failed.isError).toBe(true);
    expect(getText(failed)).toContain("socket closed");

    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 1/1 servers");
    const recovered = await registry.getTool("echo").execute("2", { text: "hello" }, undefined, undefined, { cwd: root });
    expect(recovered.isError).not.toBe(true);
    expect(getText(recovered)).toContain("recovered:hello");
  });

  it("does not reconnect for ordinary tool errors that merely contain a generic keyword", async () => {
    // Intent: arbitrary remote tool failures can mention words like "closed" without meaning
    // the transport died; reconnecting in that case would churn the server and mask real errors.
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
            toolPrefix: "",
          },
        },
      },
    });

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({
          mm: [
            {
              tools: [echoTool],
              callResult: () => {
                throw new Error("schema validation failed: field closedAt is required");
              },
            },
            {
              tools: [echoTool],
              callResult: (_name, args) => ({
                content: [{ type: "text", text: `unexpected-reconnect:${String(args.text ?? "")}` }],
              }),
            },
          ],
        }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => hasTool(registry, "echo"));

    const first = await registry.getTool("echo").execute("1", { text: "hello" }, undefined, undefined, { cwd: root });
    expect(first.isError).toBe(true);
    expect(getText(first)).toContain("field closedAt is required");

    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = await registry.getTool("echo").execute("2", { text: "hello" }, undefined, undefined, { cwd: root });
    expect(second.isError).toBe(true);
    expect(getText(second)).toContain("field closedAt is required");
    expect(getText(second)).not.toContain("unexpected-reconnect");
  });

  it("prints a tree view for /mcp-status", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      mcp: {
        servers: {
          mm: {
            type: "local",
            command: ["mock-mcp"],
            toolPrefix: "",
          },
        },
      },
    });

    const registry = createMcpRegistry({ hasUI: true, cwd: root });
    piBaseExtension(registry.pi as any, {
      mcp: {
        clientFactory: createClientFactory({ mm: [{ tools: [echoTool] }] }),
        heartbeatIntervalMs: 10_000,
        retryDelaysMs: [20],
        callWaitTimeoutMs: 20,
      },
    });

    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    await waitFor(() => registry.getStatuses().get("02-pi-base-mcp") === "MCP: 1/1 servers" && hasTool(registry, "echo"));

    await registry.runCommand("mcp-status", "", { cwd: root });

    const messages = registry.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      customType: "pi-base-mcp-status",
      display: true,
    });
    expect(String(messages[0].content)).toContain("MCP: 1/1 servers");
    expect(String(messages[0].content)).toContain("echo");
  });
});
