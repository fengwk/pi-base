import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createSdkMcpClient, resolveConfigString, resolveConfigStringMap } from "../src/mcp/client.js";

const ORIGINAL_EXAMPLE = process.env.PI_BASE_MCP_TEST_VALUE;
const ORIGINAL_CLIENT_CONNECT = Client.prototype.connect;
const ORIGINAL_CLIENT_CLOSE = Client.prototype.close;
const ORIGINAL_CLIENT_LIST_TOOLS = Client.prototype.listTools;
const ORIGINAL_CLIENT_CALL_TOOL = Client.prototype.callTool;

afterEach(() => {
  Client.prototype.connect = ORIGINAL_CLIENT_CONNECT;
  Client.prototype.close = ORIGINAL_CLIENT_CLOSE;
  Client.prototype.listTools = ORIGINAL_CLIENT_LIST_TOOLS;
  Client.prototype.callTool = ORIGINAL_CLIENT_CALL_TOOL;
  if (ORIGINAL_EXAMPLE === undefined) {
    delete process.env.PI_BASE_MCP_TEST_VALUE;
  } else {
    process.env.PI_BASE_MCP_TEST_VALUE = ORIGINAL_EXAMPLE;
  }
});

describe("mcp client config resolution", () => {
  it("expands bare and braced environment variable references", () => {
    process.env.PI_BASE_MCP_TEST_VALUE = "resolved-value";

    expect(resolveConfigString("$PI_BASE_MCP_TEST_VALUE", "test.bare")).toBe("resolved-value");
    expect(resolveConfigString("${PI_BASE_MCP_TEST_VALUE}", "test.braced")).toBe("resolved-value");
  });

  it("leaves literal strings unchanged", () => {
    expect(resolveConfigString("https://api.minimaxi.com", "test.literal")).toBe("https://api.minimaxi.com");
  });

  it("throws when a referenced environment variable is missing", () => {
    delete process.env.PI_BASE_MCP_TEST_VALUE;

    expect(() => resolveConfigString("${PI_BASE_MCP_TEST_VALUE}", "test.missing"))
      .toThrowError("test.missing references missing environment variable PI_BASE_MCP_TEST_VALUE.");
  });

  it("expands all values in a string map", () => {
    process.env.PI_BASE_MCP_TEST_VALUE = "resolved-value";

    expect(resolveConfigStringMap({ token: "${PI_BASE_MCP_TEST_VALUE}", literal: "plain" }, "test.map"))
      .toEqual({ token: "resolved-value", literal: "plain" });
  });
  it("disconnect closes an in-flight SDK client connect attempt", async () => {
    let rejectConnect: ((error: Error) => void) | undefined;
    let closed = false;
    let closeCalls = 0;

    Client.prototype.connect = (() => new Promise<void>((_resolve, reject) => {
      rejectConnect = reject;
    })) as any;
    Client.prototype.close = (async () => {
      if (closed) return;
      closed = true;
      closeCalls += 1;
      rejectConnect?.(new Error("Connection closed"));
    }) as any;

    const client = createSdkMcpClient("mm", { type: "local", command: ["mock-mcp"] });
    const connectPromise = client.connect(5_000);

    await Promise.resolve();
    await client.disconnect();

    if (closeCalls === 0) {
      rejectConnect?.(new Error("Manual stop"));
    }

    await expect(connectPromise).rejects.toBeInstanceOf(Error);
    expect(closeCalls).toBe(1);
    expect(client.isConnected()).toBe(false);
  });

  it("does not let a stale connect failure clear a newer successful connection", async () => {
    // Intent: disconnect may cancel one handshake while a replacement connects; the late rejection
    // from the old SDK client must not overwrite the replacement client's connected state.
    let rejectFirstConnect!: (error: Error) => void;
    let connectCalls = 0;
    Client.prototype.connect = (function () {
      connectCalls += 1;
      if (connectCalls === 1) {
        return new Promise<void>((_resolve, reject) => {
          rejectFirstConnect = reject;
        });
      }
      return Promise.resolve();
    }) as any;
    Client.prototype.close = (async () => undefined) as any;
    Client.prototype.listTools = (async () => ({ tools: [{ name: "replacement" }] })) as any;

    const client = createSdkMcpClient("mm", { type: "local", command: ["mock-mcp"] });
    const staleConnect = client.connect(5_000);
    await Promise.resolve();
    await client.disconnect();

    await client.connect(5_000);
    expect(client.isConnected()).toBe(true);
    rejectFirstConnect(new Error("stale connection closed"));
    await expect(staleConnect).rejects.toThrow("stale connection closed");

    expect(client.isConnected()).toBe(true);
    await expect(client.listTools()).resolves.toEqual([{ name: "replacement" }]);
    await client.disconnect();
  });

  it("connects once, lists tools, calls tools, and disconnects cleanly", async () => {
    // Intent: SdkMcpClient is the boundary around the MCP SDK; once connected it
    // must delegate listTools/callTool while tracking connection state.
    let connectCalls = 0;
    let closeCalls = 0;
    const seenListCalls: unknown[] = [];
    const seenCalls: unknown[] = [];

    Client.prototype.connect = (async () => {
      connectCalls += 1;
    }) as any;
    Client.prototype.close = (async () => {
      closeCalls += 1;
    }) as any;
    Client.prototype.listTools = (async (...args: unknown[]) => {
      seenListCalls.push(args);
      return { tools: [{ name: "echo", description: "Echo" }] };
    }) as any;
    Client.prototype.callTool = (async (...args: unknown[]) => {
      seenCalls.push(args);
      return { content: [{ type: "text", text: "ok" }] };
    }) as any;

    const client = createSdkMcpClient("mm", { type: "local", command: ["mock-mcp"], env: { TOKEN: "literal" } });
    await client.connect(1_000);
    await client.connect(1_000);

    expect(client.isConnected()).toBe(true);
    expect(connectCalls).toBe(1);
    await expect(client.listTools()).resolves.toEqual([{ name: "echo", description: "Echo" }]);
    await expect(client.listTools({ timeout: 321 })).resolves.toEqual([{ name: "echo", description: "Echo" }]);
    expect(seenListCalls).toEqual([[undefined, undefined], [undefined, { timeout: 321 }]]);
    await expect(client.callTool("echo", { text: "hello" })).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    const controller = new AbortController();
    await expect(client.callTool("echo", { text: "bounded" }, { signal: controller.signal, timeout: 123 }))
      .resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(seenCalls).toEqual([
      [{ name: "echo", arguments: { text: "hello" } }, undefined, undefined],
      [{ name: "echo", arguments: { text: "bounded" } }, undefined, { signal: controller.signal, timeout: 123 }],
    ]);

    await client.disconnect();
    expect(client.isConnected()).toBe(false);
    expect(closeCalls).toBe(1);
    await expect(client.listTools()).rejects.toThrow("MCP client is not connected");
  });

  it("times out slow SDK connections and closes the pending client", async () => {
    // Intent: startupTimeoutMs should not leave a half-open SDK client behind
    // when the underlying transport never completes its handshake.
    let closeCalls = 0;
    Client.prototype.connect = (() => new Promise(() => undefined)) as any;
    Client.prototype.close = (async () => {
      closeCalls += 1;
    }) as any;

    const client = createSdkMcpClient("mm", { type: "local", command: ["mock-mcp"] });
    await expect(client.connect(10)).rejects.toThrow("Connection timeout");
    expect(client.isConnected()).toBe(false);
    expect(closeCalls).toBe(1);
  });

  it("rejects websocket transports with custom headers", async () => {
    // Intent: the MCP SDK cannot attach custom headers to websocket transport;
    // pi-base should fail early instead of pretending the auth config works.
    let closeCalls = 0;
    Client.prototype.close = (async () => {
      closeCalls += 1;
    }) as any;

    const client = createSdkMcpClient("docs", {
      type: "remote",
      transport: "websocket",
      url: "wss://example.com/mcp",
      headers: { Authorization: "Bearer token" },
    });

    await expect(client.connect(1_000)).rejects.toThrow("websocket transport does not support custom headers");
    expect(client.isConnected()).toBe(false);
    expect(closeCalls).toBe(0);
  });
});
