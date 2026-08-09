import { describe, expect, it, vi } from "vitest";
import { McpSessionBinding } from "../src/mcp/binding.js";
import { registerMcpSupport } from "../src/mcp/register.js";
import { createMcpHub } from "../src/mcp/hub.js";
import { createMcpHubRegistry } from "../src/mcp/registry.js";
import { DEPTH_ENTRY, ROOT_SESSION_ENTRY, rootSessionEntryData } from "../src/subagent/depth.js";
import type { McpProtocolClient, McpToolCallResult } from "../src/mcp/types.js";
import { createToolRegistry, getText } from "./helpers.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function rootSessionManager(rootSessionId: string) {
  return {
    getEntries: () => [],
    getSessionId: () => rootSessionId,
  };
}

function childSessionManager(rootSessionId: string) {
  return {
    getEntries: () => [
      { type: "custom", customType: DEPTH_ENTRY, data: { depth: 2 } },
      { type: "custom", customType: ROOT_SESSION_ENTRY, data: rootSessionEntryData(rootSessionId) },
    ],
    getSessionId: () => "child-session",
  };
}

describe("process-level MCP sharing", () => {
  it("starts one server, blocks parent and child readiness, and shares calls", async () => {
    // Intent: a root and its children must share one MCP client/server and wait
    // for the same initial readiness barrier before their first prompt.
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
    const config = {
      servers: {
        mm: { type: "local" as const, command: ["mock-mcp"], toolPrefix: "" },
      },
    };
    const options = {
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
    const rootSessionId = "sharing-root";

    let rootStarted = false;
    let childStarted = false;
    const rootStart = root.emit("session_start", { reason: "startup" }, {
      cwd: "/workspace",
      sessionManager: rootSessionManager(rootSessionId),
    }).then(() => { rootStarted = true; });
    const childStart = child.emit("session_start", { reason: "startup" }, {
      cwd: "/workspace",
      hasUI: false,
      sessionManager: childSessionManager(rootSessionId),
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
      sessionManager: childSessionManager(rootSessionId),
    });
    expect(disconnectCalls).toBe(0);
    expect(getText(await root.getTool("echo").execute("3", { text: "still-live" }, undefined, undefined, { cwd: "/workspace" })))
      .toBe("still-live");

    await root.emit("session_shutdown", { reason: "quit" }, {
      cwd: "/workspace",
      sessionManager: rootSessionManager(rootSessionId),
    });
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
    const options = {
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
    const rootSessionId = "root-before-child";

    await Promise.all([
      root.emit("session_start", { reason: "startup" }, {
        cwd: "/workspace",
        sessionManager: rootSessionManager(rootSessionId),
      }),
      child.emit("session_start", { reason: "startup" }, {
        cwd: "/workspace",
        hasUI: false,
        sessionManager: childSessionManager(rootSessionId),
      }),
    ]);
    expect(factoryCalls).toBe(1);

    await root.emit("session_shutdown", { reason: "quit" }, {
      cwd: "/workspace",
      sessionManager: rootSessionManager(rootSessionId),
    });
    expect(disconnectCalls).toBe(0);
    expect(getText(await child.getTool("echo").execute("1", { text: "still-live" }, undefined, undefined, { cwd: "/workspace" })))
      .toBe("still-live");

    await child.emit("session_shutdown", { reason: "quit" }, {
      cwd: "/workspace",
      hasUI: false,
      sessionManager: childSessionManager(rootSessionId),
    });
    expect(disconnectCalls).toBe(1);
  });

  it("isolates simultaneous roots with different MCP configurations", async () => {
    // Intent: the production process registry is keyed by root session, so one
    // root's server discovery and calls cannot replace another root's tools.
    const calls: string[] = [];
    const createClient = (toolName: string, result: string): McpProtocolClient => ({
      async connect() {},
      async disconnect() {},
      async listTools() {
        return [{ name: toolName, inputSchema: { type: "object" } }];
      },
      async callTool(name): Promise<McpToolCallResult> {
        calls.push(name);
        return { content: [{ type: "text", text: result }] };
      },
      isConnected() {
        return true;
      },
    });
    const rootA = createToolRegistry({ cwd: "/workspace-a" });
    const rootB = createToolRegistry({ cwd: "/workspace-b" });
    registerMcpSupport(rootA.pi as any, {
      loadSettings: () => ({
        settings: { mcp: { servers: { a: { type: "local", command: ["server-a"], toolPrefix: "" } } } },
      } as any),
      clientFactory: () => createClient("tool_a", "result-a"),
      heartbeatIntervalMs: 10_000,
    });
    registerMcpSupport(rootB.pi as any, {
      loadSettings: () => ({
        settings: { mcp: { servers: { b: { type: "local", command: ["server-b"], toolPrefix: "" } } } },
      } as any),
      clientFactory: () => createClient("tool_b", "result-b"),
      heartbeatIntervalMs: 10_000,
    });

    await Promise.all([
      rootA.emit("session_start", { reason: "startup" }, {
        cwd: "/workspace-a",
        sessionManager: rootSessionManager("isolated-root-a"),
      }),
      rootB.emit("session_start", { reason: "startup" }, {
        cwd: "/workspace-b",
        sessionManager: rootSessionManager("isolated-root-b"),
      }),
    ]);

    expect(rootA.getTool("tool_a")).toBeDefined();
    expect(() => rootA.getTool("tool_b")).toThrow("Tool not registered");
    expect(rootB.getTool("tool_b")).toBeDefined();
    expect(() => rootB.getTool("tool_a")).toThrow("Tool not registered");
    expect(getText(await rootA.getTool("tool_a").execute("a", {}, undefined, undefined, { cwd: "/workspace-a" })))
      .toBe("result-a");
    expect(getText(await rootB.getTool("tool_b").execute("b", {}, undefined, undefined, { cwd: "/workspace-b" })))
      .toBe("result-b");
    expect(calls).toEqual(["tool_a", "tool_b"]);

    await rootA.emit("session_shutdown", { reason: "quit" }, {
      cwd: "/workspace-a",
      sessionManager: rootSessionManager("isolated-root-a"),
    });
    expect(getText(await rootB.getTool("tool_b").execute("b2", {}, undefined, undefined, { cwd: "/workspace-b" })))
      .toBe("result-b");
    await rootB.emit("session_shutdown", { reason: "quit" }, {
      cwd: "/workspace-b",
      sessionManager: rootSessionManager("isolated-root-b"),
    });
  });

  it("keeps explicit hub injection shared across root ids", async () => {
    // Intent: tests and custom integrations that inject a hub retain the former
    // direct-sharing contract instead of being routed through the root registry.
    let factoryCalls = 0;
    let disconnectCalls = 0;
    const hub = createMcpHub();
    const options = {
      hub,
      loadSettings: () => ({
        settings: { mcp: { servers: { shared: { type: "local", command: ["shared"], toolPrefix: "" } } } },
      } as any),
      clientFactory: (): McpProtocolClient => {
        factoryCalls += 1;
        return {
          async connect() {},
          async disconnect() { disconnectCalls += 1; },
          async listTools() { return [{ name: "shared_tool" }]; },
          async callTool() { return { content: [{ type: "text", text: "shared" }] }; },
          isConnected() { return disconnectCalls === 0; },
        };
      },
      heartbeatIntervalMs: 10_000,
    };
    const first = createToolRegistry();
    const second = createToolRegistry();
    registerMcpSupport(first.pi as any, options);
    registerMcpSupport(second.pi as any, options);

    await Promise.all([
      first.emit("session_start", { reason: "startup" }, {
        sessionManager: rootSessionManager("injected-root-a"),
      }),
      second.emit("session_start", { reason: "startup" }, {
        sessionManager: rootSessionManager("injected-root-b"),
      }),
    ]);
    expect(factoryCalls).toBe(1);
    expect(first.getTool("shared_tool")).toBeDefined();
    expect(second.getTool("shared_tool")).toBeDefined();

    await first.emit("session_shutdown", { reason: "quit" }, {
      sessionManager: rootSessionManager("injected-root-a"),
    });
    expect(disconnectCalls).toBe(0);
    await second.emit("session_shutdown", { reason: "quit" }, {
      sessionManager: rootSessionManager("injected-root-b"),
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
    // Intent: extension/session replacement must not restart the root-scoped
    // process-level MCP server when the effective configuration did not change.
    let factoryCalls = 0;
    let disconnectCalls = 0;
    const makeClient = (): McpProtocolClient => ({
      async connect() {},
      async disconnect() { disconnectCalls += 1; },
      async listTools() { return [{ name: "echo" }]; },
      async callTool() { return { content: [{ type: "text", text: "ok" }] }; },
      isConnected() { return true; },
    });
    const options = {
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
    const rootSessionId = "reload-root";
    await first.emit("session_start", { reason: "startup" }, {
      cwd: "/workspace",
      sessionManager: rootSessionManager(rootSessionId),
    });
    await first.emit("session_shutdown", { reason: "reload" }, {
      cwd: "/workspace",
      sessionManager: rootSessionManager(rootSessionId),
    });

    const second = createToolRegistry({ cwd: "/workspace" });
    registerMcpSupport(second.pi as any, options);
    await second.emit("session_start", { reason: "reload" }, {
      cwd: "/workspace",
      sessionManager: rootSessionManager(rootSessionId),
    });

    expect(factoryCalls).toBe(1);
    expect(disconnectCalls).toBe(0);
    expect(second.getTool("echo")).toBeDefined();

    await second.emit("session_shutdown", { reason: "quit" }, {
      cwd: "/workspace",
      sessionManager: rootSessionManager(rootSessionId),
    });
    expect(disconnectCalls).toBe(1);
  });

  it("terminates the old root hub when session replacement reason is new", async () => {
    // Intent: every root shutdown except reload ends that delegation tree. A
    // later session using either the replacement id or the old id needs a fresh Hub.
    let factoryCalls = 0;
    let disconnectCalls = 0;
    const options = {
      loadSettings: () => ({
        settings: { mcp: { servers: { mm: { type: "local", command: ["mock-mcp"], toolPrefix: "" } } } },
      } as any),
      clientFactory: (): McpProtocolClient => {
        factoryCalls += 1;
        let connected = false;
        return {
          async connect() { connected = true; },
          async disconnect() {
            if (connected) disconnectCalls += 1;
            connected = false;
          },
          async listTools() { return [{ name: "echo" }]; },
          async callTool() { return { content: [{ type: "text", text: "ok" }] }; },
          isConnected() { return connected; },
        };
      },
      heartbeatIntervalMs: 10_000,
    };
    const replacement = createToolRegistry();
    registerMcpSupport(replacement.pi as any, options);

    await replacement.emit("session_start", { reason: "startup" }, {
      sessionManager: rootSessionManager("replacement-old-root"),
    });
    await replacement.emit("session_shutdown", { reason: "new" }, {
      sessionManager: rootSessionManager("replacement-old-root"),
    });
    expect(disconnectCalls).toBe(1);

    await replacement.emit("session_start", { reason: "new" }, {
      sessionManager: rootSessionManager("replacement-new-root"),
    });
    expect(factoryCalls).toBe(2);
    await replacement.emit("session_shutdown", { reason: "quit" }, {
      sessionManager: rootSessionManager("replacement-new-root"),
    });
    expect(disconnectCalls).toBe(2);

    const oldRootProbe = createToolRegistry();
    registerMcpSupport(oldRootProbe.pi as any, options);
    await oldRootProbe.emit("session_start", { reason: "resume" }, {
      sessionManager: rootSessionManager("replacement-old-root"),
    });
    expect(factoryCalls).toBe(3);
    await oldRootProbe.emit("session_shutdown", { reason: "quit" }, {
      sessionManager: rootSessionManager("replacement-old-root"),
    });
    expect(disconnectCalls).toBe(3);
  });

  it("does not acquire a replacement lease after a superseded root switch", async () => {
    // Intent: if generation changes while prepareBinding is stopping the previous
    // root, it must finish terminal cleanup and return without leaking a new lease.
    let factoryCalls = 0;
    let disconnectCalls = 0;
    const options = {
      loadSettings: () => ({
        settings: { mcp: { servers: { mm: { type: "local", command: ["mock-mcp"], toolPrefix: "" } } } },
      } as any),
      clientFactory: (): McpProtocolClient => {
        factoryCalls += 1;
        let connected = false;
        return {
          async connect() { connected = true; },
          async disconnect() {
            if (connected) disconnectCalls += 1;
            connected = false;
          },
          async listTools() { return [{ name: "echo" }]; },
          async callTool() { return { content: [{ type: "text", text: "ok" }] }; },
          isConnected() { return connected; },
        };
      },
      heartbeatIntervalMs: 10_000,
    };
    const switching = createToolRegistry();
    registerMcpSupport(switching.pi as any, options);
    await switching.emit("session_start", { reason: "startup" }, {
      sessionManager: rootSessionManager("race-old-root"),
    });

    const stopEntered = deferred();
    const allowStop = deferred();
    const originalStop = McpSessionBinding.prototype.stop;
    const stopSpy = vi.spyOn(McpSessionBinding.prototype, "stop")
      .mockImplementationOnce(async function (this: McpSessionBinding) {
        stopEntered.resolve();
        await allowStop.promise;
        await originalStop.call(this);
      });
    try {
      const staleStart = switching.emit("session_start", { reason: "reload" }, {
        sessionManager: rootSessionManager("race-new-root"),
      });
      await stopEntered.promise;
      await switching.emit("session_shutdown", { reason: "reload" }, {
        sessionManager: rootSessionManager("race-new-root"),
      });
      allowStop.resolve();
      await staleStart;

      expect(disconnectCalls).toBe(1);
      expect(factoryCalls).toBe(1);

      const probe = createToolRegistry();
      registerMcpSupport(probe.pi as any, options);
      await probe.emit("session_start", { reason: "resume" }, {
        sessionManager: rootSessionManager("race-new-root"),
      });
      expect(factoryCalls).toBe(2);
      await probe.emit("session_shutdown", { reason: "quit" }, {
        sessionManager: rootSessionManager("race-new-root"),
      });
      expect(disconnectCalls).toBe(2);
    } finally {
      allowStop.resolve();
      stopSpy.mockRestore();
    }
  });

  it("keeps a replacement entry when an older terminal release finishes later", async () => {
    // Intent: a delayed shutdown from an old root lifetime must not delete a new
    // registry entry that reused the same persisted root session id.
    const shutdownGate = deferred();
    const registry = createMcpHubRegistry();
    const oldLease = registry.acquire("reused-root");
    const oldShutdown = oldLease.hub.shutdown.bind(oldLease.hub);
    oldLease.hub.shutdown = async () => {
      await shutdownGate.promise;
      await oldShutdown();
    };
    oldLease.markTerminal();
    const releasingOld = oldLease.release();

    const replacement = registry.acquire("reused-root");
    expect(replacement.hub).not.toBe(oldLease.hub);
    shutdownGate.resolve();
    await releasingOld;

    const follower = registry.acquire("reused-root");
    expect(follower.hub).toBe(replacement.hub);
    await oldLease.release();
    replacement.markTerminal();
    await replacement.release();
    await follower.release();
  });
});
