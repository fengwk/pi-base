import { describe, expect, it } from "vitest";
import { detectOsLabelFrom, registerBashRendererTool } from "../src/bash-renderer.js";
import { createToolRegistry } from "./helpers.js";

function render(component: any): string {
  return component.render(200).join("\n");
}

describe("bash renderer extra coverage", () => {
  it("renders concise calls without default workdir noise and with timeout", () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
    });

    const tool = registry.getTool("bash");
    const rendered = render(tool.renderCall({ timeout_seconds: 9 }, {} as any, { lastComponent: undefined }));
    expect(rendered).toContain("$ <missing-command>");
    expect(rendered).toContain("timeout 9s");
    expect(rendered).not.toContain("(default)");
  });

  it("falls back cleanly when proc file reads throw during OS detection", () => {
    expect(detectOsLabelFrom({
      platform: "linux",
      env: {},
      readTextFile: () => {
        throw new Error("boom");
      },
    })).toBe("linux");
  });

  it("falls back to the pi-base renderer when an injected builtin renderer throws", () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
      createBuiltInBashToolDefinition: () => ({
        renderResult: () => {
          throw new Error("broken builtin renderer");
        },
      }),
    });

    const tool = registry.getTool("bash");
    const rendered = render(tool.renderResult(
      { content: [{ type: "text", text: "line-1\nline-2" }] },
      { expanded: false, isPartial: false },
      {} as any,
      { lastComponent: undefined, args: { workdir: "." }, cwd: process.cwd(), state: { startedAt: Date.now(), endedAt: Date.now() } },
    ));

    expect(rendered).toContain("line-1");
    expect(rendered).toContain("Took");
  });

  it("shows elapsed timing in partial renders and final timing in completed renders", () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
    });

    const tool = registry.getTool("bash");
    const state: any = { startedAt: Date.now() - 1200 };
    const partial = render(tool.renderResult(
      { content: [{ type: "text", text: "running" }] },
      { expanded: false, isPartial: true },
      {} as any,
      { lastComponent: undefined, args: { workdir: "." }, cwd: process.cwd(), state, invalidate: () => undefined },
    ));
    expect(partial).toContain("Elapsed");

    const completed = render(tool.renderResult(
      { content: [{ type: "text", text: "done" }] },
      { expanded: false, isPartial: false },
      {} as any,
      { lastComponent: undefined, args: { workdir: "." }, cwd: process.cwd(), state, invalidate: () => undefined },
    ));
    expect(completed).toContain("Took");
  });
});
