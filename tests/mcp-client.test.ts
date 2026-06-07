import { afterEach, describe, expect, it } from "vitest";
import { resolveConfigString, resolveConfigStringMap } from "../src/mcp/client.js";

const ORIGINAL_EXAMPLE = process.env.PI_BASE_MCP_TEST_VALUE;

afterEach(() => {
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
});
