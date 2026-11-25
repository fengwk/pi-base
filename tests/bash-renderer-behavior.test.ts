import { describe, expect, it } from "vitest";
import { registerBashRendererTool } from "../src/bash-renderer.js";
import { createToolRegistry } from "./helpers.js";

function render(component: any): string {
  return component.render(200).join("\n");
}

describe("bash renderer behavior", () => {
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

  it("shows a bounded error tail when successful Bash previews are disabled", () => {
    // Intent: a zero-line success policy must still expose the most relevant stderr tail and an expansion path.
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
      getCollapsedResultLines: () => 0,
    });
    const tool = registry.getTool("bash");
    const output = Array.from({ length: 12 }, (_, index) => `error-${index + 1}`).join("\n");
    const context = {
      lastComponent: undefined,
      args: { workdir: "." },
      cwd: process.cwd(),
      state: { startedAt: Date.now(), endedAt: Date.now() },
      isError: true,
    };

    const collapsed = render(tool.renderResult(
      { content: [{ type: "text", text: output }] },
      { expanded: false, isPartial: false },
      {} as any,
      context,
    ));
    expect(collapsed).not.toContain("error-3");
    expect(collapsed).toContain("error-4");
    expect(collapsed).toContain("error-12");
    expect(collapsed).toContain("3 earlier lines");
    expect(collapsed).toContain("ctrl+o to expand");

    const expanded = render(tool.renderResult(
      { content: [{ type: "text", text: output }] },
      { expanded: true, isPartial: false },
      {} as any,
      context,
    ));
    expect(expanded).toContain("error-1");
    expect(expanded).not.toContain("ctrl+o to expand");
  });

  it("shows upstream full-output storage failures even with the Bash preview disabled", () => {
    // Pi 1.6.1 includes the reason in its footer and details. Show it once, outside the preview.
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, { getCollapsedResultLines: () => 0 });
    const tool = registry.getTool("bash");
    const storageError = "ENOSPC: no space left on device";
    const warning = `Could not save the full output: ${storageError}`;
    const result = {
      content: [{ type: "text", text: `command output\n\n[Showing lines 2-2 of 2. ${warning}]` }],
      details: { fullOutputError: storageError, truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 2 } },
    };
    const context = { cwd: process.cwd(), state: {} };
    const collapsed = render(tool.renderResult(result, { expanded: false }, {}, context));
    expect(collapsed).toContain(warning);
    expect(collapsed).not.toContain("command output");

    const failedResult = { ...result, content: [{ type: "text", text: `${result.content[0]!.text}\n\nCommand exited with code 7` }] };
    const expanded = render(tool.renderResult(failedResult, { expanded: true }, {}, { ...context, isError: true }));
    expect(expanded).toContain("command output");
    expect(expanded).toContain("Command exited with code 7");
    expect(expanded.split(warning)).toHaveLength(2);
    expect(expanded).not.toContain("[Showing lines");
  });

  it("does not offer expansion when a disabled Bash preview shows the complete error", () => {
    // Intent: retaining a short diagnostic is not truncation and must not imply hidden output.
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
      getCollapsedResultLines: () => 0,
    });
    const tool = registry.getTool("bash");
    const rendered = render(tool.renderResult(
      { content: [{ type: "text", text: "command failed" }] },
      { expanded: false, isPartial: false },
      {} as any,
      {
        lastComponent: undefined,
        args: { workdir: "." },
        cwd: process.cwd(),
        state: {},
        isError: true,
      },
    ));

    expect(rendered).toContain("command failed");
    expect(rendered).not.toContain("ctrl+o to expand");
    expect(rendered).not.toContain("...");
  });
});
