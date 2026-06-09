import { describe, expect, it } from "vitest";
import { registerMcpSupport } from "../src/mcp/index.js";
import { createToolRegistry } from "./helpers.js";

function render(component: any): string {
  return component.render(120).join("\n");
}

describe("mcp index extra coverage", () => {
  it("requires loadSettings", () => {
    const registry = createToolRegistry();
    expect(() => registerMcpSupport(registry.pi as any)).toThrow("registerMcpSupport requires loadSettings");
  });

  it("renders the registered MCP status message type", () => {
    const registry = createToolRegistry();
    registerMcpSupport(registry.pi as any, {
      loadSettings: () => ({ settings: { mcp: { servers: {} } } } as any),
    });

    const renderer = registry.getMessageRenderer("pi-base-mcp-status");
    const rendered = render(renderer({ content: "hello" }));
    expect(rendered).toContain("hello");
  });

  it("requires bare /mcp-status without arguments", async () => {
    const registry = createToolRegistry({ hasUI: true });
    registerMcpSupport(registry.pi as any, {
      loadSettings: () => ({ settings: { mcp: { servers: {} } } } as any),
    });

    await registry.runCommand("mcp-status", "extra", {});
    expect(registry.getNotifications()).toContainEqual({ message: "Usage: /mcp-status", variant: "warning" });
  });
});
