import { describe, expect, it } from "vitest";
import { registerMcpSupport } from "../src/mcp/register.js";
import { createMcpHub } from "../src/mcp/hub.js";
import { DEPTH_ENTRY } from "../src/subagent/depth.js";
import type { McpProtocolClient, McpToolCallResult } from "../src/mcp/types.js";
import { createToolRegistry, getText } from "./helpers.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function childSessionManager() {
  return {
    getEntries: () => [{ type: "custom", customType: DEPTH_ENTRY, data: { depth: 2 } }],
    getSessionId: () => "child-session",
  };
}

describe("process-level MCP sharing", () => {
  it("starts one server, blocks parent and child readiness, and shares calls", async () => {
    // Intent: all sessions in one Pi process must share one MCP client/server and
    // wait for the same initial readiness barrier before their first prompt.
    const ready = deferred();
    let factoryCalls = 0;
    let disconnectCalls = 0;
    let toolCalls = 0;
    const client: McpProtocolClient = {
      async connect() {
        await ready.promise;
      },
      async disconnect() {
        disconnectCalls += 1;
      },
      async listTools() {
        return [{ name: "echo", inputSchema: { type: "object" } }];
      },
      async callTool(_name, args): Promise<McpToolCallResult> {
        toolCalls += 1;
        return { content: [{ type: "text", text: String(args.text) }] };
      },
      isConnected() {
        return disconnectCalls === 0;
      },
    };
    const hub = createMcpHub();
    const config = {
      servers: {
        mm: { type: "local" as const, command: ["mock-mcp"], toolPrefix: "" },
      },
    };
    const options = {
      hub,
      loadSettings: () => ({ settings: { mcp: config } } as any),
      clientFactory: () => {
        factoryCalls += 1;
        return client;
      },
      heartbeatIntervalMs: 10_000,
    };
    const root = createToolRegistry({ cwd: "/workspace" });
    const child = createToolRegistry({ cwd: "/workspace", hasUI: false });
    registerMcpSupport(root.pi as any, options);
    registerMcpSupport(child.pi as any, options);

    let rootStarted = false;
    let childStarted = false;
    const rootStart = root.emit("session_start", { reason: "startup" }, { cwd: "/workspace" }).then(() => { rootStarted = true; });
    const childStart = child.emit("session_start", { reason: "startup" }, {
      cwd: "/workspace",
      hasUI: false,
      sessionManager: childSessionManager(),
    }).then(() => { childStarted = true; });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(factoryCalls).toBe(1);
    expect(rootStarted).toBe(false);
    expect(childStarted).toBe(false);

    ready.resolve();
    await Promise.all([rootStart, childStart]);
    expect(root.getTool("echo")).toBeDefined();
    expect(child.getTool("echo")).toBeDefined();

    const [rootResult, childResult] = await Promise.all([
      root.getTool("echo").execute("1", { text: "root" }, undefined, undefined, { cwd: "/workspace" }),
      child.getTool("echo").execute("2", { text: "child" }, undefined, undefined, { cwd: "/workspace" }),
    ]);
    expect(getText(rootResult)).toBe("root");
    expect(getText(childResult)).toBe("child");
    expect(toolCalls).toBe(2);

    await child.emit("session_shutdown", { reason: "quit" }, {
      cwd: "/workspace",
      hasUI: false,
      sessionManager: childSessionManager(),
    });
    expect(disconnectCalls).toBe(0);
    expect(getText(await root.getTool("echo").execute("3", { text: "still-live" }, undefined, undefined, { cwd: "/workspace" })))
      .toBe("still-live");

    await root.emit("session_shutdown", { reason: "quit" }, { cwd: "/workspace" });
    expect(disconnectCalls).toBe(1);
  });

  it("keeps the shared server alive until the last child exits after root shutdown", async () => {
    // Intent: root shutdown requests process-level cleanup, but an attached child
    // must keep the shared server alive until that final session releases it.
    let factoryCalls = 0;
    let disconnectCalls = 0;
    const client: McpProtocolClient = {
      async connect() {},
      async disconnect() {
        disconnectCalls += 1;
      },
      async listTools() {
        return [{ name: "echo", inputSchema: { type: "object" } }];
      },
      async callTool(_name, args): Promise<McpToolCallResult> {
        return { content: [{ type: "text", text: String(args.text) }] };
      },
      isConnected() {
        return disconnectCalls === 0;
      },
    };
    const hub = createMcpHub();
    const options = {
      hub,
      loadSettings: () => ({
        settings: {
          mcp: {
            servers: {
              mm: { type: "local" as const, command: ["mock-mcp"], toolPrefix: "" },
            },
          },
        },
      } as any),
      clientFactory: () => {
        factoryCalls += 1;
        return client;
      },
      heartbeatIntervalMs: 10_000,
    };
    const root = createToolRegistry({ cwd: "/workspace" });
    const child = createToolRegistry({ cwd: "/workspace", hasUI: false });
    registerMcpSupport(root.pi as any, options);
    registerMcpSupport(child.pi as any, options);

    await Promise.all([
      root.emit("session_start", { reason: "startup" }, { cwd: "/workspace" }),
      child.emit("session_start", { reason: "startup" }, {
        cwd: "/workspace",
        hasUI: false,
        sessionManager: childSessionManager(),
      }),
    ]);
    expect(factoryCalls).toBe(1);

    await root.emit("session_shutdown", { reason: "quit" }, { cwd: "/workspace" });
    expect(disconnectCalls).toBe(0);
    expect(getText(await child.getTool("echo").execute("1", { text: "still-live" }, undefined, undefined, { cwd: "/workspace" })))
      .toBe("still-live");

    await child.emit("session_shutdown", { reason: "quit" }, {
      cwd: "/workspace",
      hasUI: false,
      sessionManager: childSessionManager(),
    });
    expect(disconnectCalls).toBe(1);
  });

  it("interrupts an in-flight startup when the process hub shuts down", async () => {
    // Intent: quitting during startup must close the pending client immediately
    // instead of waiting for the configured startup timeout.
    let rejectConnect: ((error: Error) => void) | undefined;
    let disconnectCalls = 0;
    const hub = createMcpHub();
    const configuring = hub.configure({
      startupTimeoutMs: 60_000,
      servers: { mm: { type: "local", command: ["mock-mcp"] } },
    }, {
      clientFactory: () => ({
        connect: () => new Promise<void>((_resolve, reject) => { rejectConnect = reject; }),
        async disconnect() {
          disconnectCalls += 1;
          rejectConnect?.(new Error("closed"));
        },
        async listTools() { return []; },
        async callTool() { return {}; },
        isConnected() { return false; },
      }),
    });

    while (!rejectConnect) await Promise.resolve();
    await hub.shutdown();
    await configuring;

    expect(disconnectCalls).toBe(1);
    expect(hub.getSnapshot().servers).toEqual([]);
  });

  it("preempts an in-flight startup when a newer configuration arrives", async () => {
    // Intent: reload with changed MCP settings must replace the pending startup;
    // the older configure call must not resurrect its server afterward.
    let rejectFirst: ((error: Error) => void) | undefined;
    let firstDisconnects = 0;
    let secondFactoryCalls = 0;
    const hub = createMcpHub();
    const first = hub.configure({
      servers: { first: { type: "local", command: ["first"] } },
    }, {
      clientFactory: () => ({
        connect: () => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }),
        async disconnect() {
          firstDisconnects += 1;
          rejectFirst?.(new Error("reconfigured"));
        },
        async listTools() { return []; },
        async callTool() { return {}; },
        isConnected() { return false; },
      }),
    });
    while (!rejectFirst) await Promise.resolve();

    const second = hub.configure({
      servers: { second: { type: "local", command: ["second"] } },
    }, {
      clientFactory: () => {
        secondFactoryCalls += 1;
        return {
          async connect() {},
          async disconnect() {},
          async listTools() { return [{ name: "ready" }]; },
          async callTool() { return {}; },
          isConnected() { return true; },
        };
      },
    });

    await Promise.all([first, second]);
    expect(firstDisconnects).toBe(1);
    expect(secondFactoryCalls).toBe(1);
    expect(hub.getSnapshot().servers.map((server) => server.key)).toEqual(["second"]);
    expect(hub.getSnapshot().servers[0]?.tools[0]?.tool.name).toBe("ready");
    await hub.shutdown();
  });

  it("does not let an older shutdown reset defaults from a newer configuration", async () => {
    // Intent: a new session may attach while the previous last-session shutdown is still waiting
    // for disconnect; once the newer config wins, the older shutdown must not overwrite its timeouts.
    const disconnectGate = deferred();
    let oldDisconnectStarted = false;
    let observedCallTimeout: number | undefined;
    const hub = createMcpHub();
    await hub.configure({
      servers: { old: { type: "local", command: ["old"] } },
    }, {
      clientFactory: () => ({
        async connect() {},
        async disconnect() {
          oldDisconnectStarted = true;
          await disconnectGate.promise;
        },
        async listTools() { return [{ name: "old_tool" }]; },
        async callTool() { return {}; },
        isConnected() { return true; },
      }),
    });

    const shuttingDown = hub.shutdown();
    while (!oldDisconnectStarted) await Promise.resolve();
    await hub.configure({
      callTimeoutMs: 321,
      servers: { next: { type: "local", command: ["next"] } },
    }, {
      clientFactory: () => ({
        async connect() {},
        async disconnect() {},
        async listTools() { return [{ name: "next_tool" }]; },
        async callTool(_name, _args, options) {
          observedCallTimeout = options?.timeout;
          return { content: [{ type: "text", text: "ok" }] };
        },
        isConnected() { return true; },
      }),
    });

    disconnectGate.resolve();
    await shuttingDown;
    await hub.call("next", "next_tool", {});

    expect(observedCallTimeout).toBe(321);
    expect(hub.getSnapshot().servers.map((server) => server.key)).toEqual(["next"]);
    await hub.shutdown();
  });

  it("keeps the shared server across root reload when config is unchanged", async () => {
    // Intent: extension/session replacement must not restart the process-level MCP
    // server when the effective configuration did not change.
    let factoryCalls = 0;
    let disconnectCalls = 0;
    const makeClient = (): McpProtocolClient => ({
      async connect() {},
      async disconnect() { disconnectCalls += 1; },
      async listTools() { return [{ name: "echo" }]; },
      async callTool() { return { content: [{ type: "text", text: "ok" }] }; },
      isConnected() { return true; },
    });
    const hub = createMcpHub();
    const options = {
      hub,
      loadSettings: () => ({
        settings: { mcp: { servers: { mm: { type: "local", command: ["mock-mcp"], toolPrefix: "" } } } },
      } as any),
      clientFactory: () => {
        factoryCalls += 1;
        return makeClient();
      },
      heartbeatIntervalMs: 10_000,
    };
    const first = createToolRegistry({ cwd: "/workspace" });
    registerMcpSupport(first.pi as any, options);
    await first.emit("session_start", { reason: "startup" }, { cwd: "/workspace" });
    await first.emit("session_shutdown", { reason: "reload" }, { cwd: "/workspace" });

    const second = createToolRegistry({ cwd: "/workspace" });
    registerMcpSupport(second.pi as any, options);
    await second.emit("session_start", { reason: "reload" }, { cwd: "/workspace" });

    expect(factoryCalls).toBe(1);
    expect(disconnectCalls).toBe(0);
    expect(second.getTool("echo")).toBeDefined();

    await second.emit("session_shutdown", { reason: "quit" }, { cwd: "/workspace" });
    expect(disconnectCalls).toBe(1);
  });
});
