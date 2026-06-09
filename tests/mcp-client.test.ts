import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createSdkMcpClient, resolveConfigString, resolveConfigStringMap } from "../src/mcp/client.js";

const ORIGINAL_EXAMPLE = process.env.PI_BASE_MCP_TEST_VALUE;
const ORIGINAL_CLIENT_CONNECT = Client.prototype.connect;
const ORIGINAL_CLIENT_CLOSE = Client.prototype.close;

afterEach(() => {
  Client.prototype.connect = ORIGINAL_CLIENT_CONNECT;
  Client.prototype.close = ORIGINAL_CLIENT_CLOSE;
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
});
