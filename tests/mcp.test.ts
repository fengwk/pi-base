import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import piBaseExtension from "../index.js";
import { createMcpManager } from "../src/mcp/manager.js";
import type { McpClientFactory, McpProtocolClient, McpTool, McpToolCallResult } from "../src/mcp/types.js";
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
  callResult?: (name: string, args: Record<string, unknown>) => McpToolCallResult;
}

class FakeMcpClient implements McpProtocolClient {
  private connected = false;

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
    await waitFor(() => registry.getStatuses().get("pi-base-mcp") === "MCP: 1/1 servers" && hasTool(registry, "echo"));

    const result = await registry.getTool("echo").execute("1", { text: "hello" }, undefined, undefined, { cwd: root });
    expect(getText(result)).toContain("echo:hello");
    expect(registry.getStatuses().get("pi-base-mcp")).toBe("MCP: 1/1 servers");
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
      content: [{ type: "text", text: longLine }],
    } as any, { expanded: false, isPartial: false }, {}, renderContext as any);
    const collapsedText = (collapsedComponent?.render(120).join("\n") ?? "").trimEnd();
    expect(collapsedText).toContain("ctrl+o to expand");
    expect(collapsedText).not.toContain(longLine);
    expect(collapsedText).toContain("output truncated");
    expect(collapsedText).toContain("xxxxxxxxxxxxxxxxxxxx...");

    const expandedComponent = tool.renderResult?.({
      content: [{ type: "text", text: longLine }],
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
    await waitFor(() => registry.getStatuses().get("pi-base-mcp") === "MCP: 1/1 servers");

    const footerLines = registry.renderFooter(120);
    expect(footerLines.length).toBeGreaterThanOrEqual(2);
    expect(footerLines.at(-2) ?? "").toContain("YOLO");
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
    await waitFor(() => registry.getStatuses().get("pi-base-mcp") === "MCP: 0/1 servers connecting");
    await waitFor(() => registry.getStatuses().get("pi-base-mcp") === "MCP: 1/1 servers");
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
    await waitFor(() => registry.getStatuses().get("pi-base-mcp") === "MCP: 0/1 servers connection failed");
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
    await waitFor(() => registry.getStatuses().get("pi-base-mcp") === "MCP: 1/1 servers" && hasTool(registry, "mm_echo"), 1_500);

    expect(registry.getStatuses().get("pi-base-mcp")).toBe("MCP: 1/1 servers");
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
    await waitFor(() => registry.getStatuses().get("pi-base-mcp") === "MCP: 1/1 servers" && hasTool(registry, "echo"));

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
