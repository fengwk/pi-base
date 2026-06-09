import { describe, expect, it } from "vitest";
import { formatSubagentCall, formatSubagentResultSummary, registerSubagentTool } from "../src/subagent/tool.js";
import { createToolRegistry } from "./helpers.js";

function render(component: any): string {
  return component.render(200).join("\n");
}
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};


describe("subagent tool formatters", () => {
  it("formats calls and result summaries directly", () => {
    const call = formatSubagentCall({ name: "coder", prompt: "full prompt", session_id: "s1" }, theme);
    expect(call).toContain("subagent coder");
    expect(call).toContain("mode: resume s1");
    expect(call).toContain("full prompt");

    const summary = formatSubagentResultSummary({
      sessionId: "s1",
      mode: "resume",
      name: "reviewer",
      status: "completed",
      tailLines: ["line-1", "line-2"],
      summary: "line-2",
    }, theme);
    expect(summary).toContain("subagent result reviewer");
    expect(summary).toContain("line-2");
  });
});
describe("subagent tool", () => {
  it("renders full prompt previews in renderCall", () => {
    const registry = createToolRegistry();
    registerSubagentTool(registry.pi as any, {
      executor: async () => ({ content: [{ type: "text", text: "unused" }], details: { mode: "new", name: "coder", status: "completed", tailLines: ["done"], summary: "done" } }),
    });

    const tool = registry.getTool("subagent");
    const prompt = "line one\nline two\nline three";
    const rendered = render(tool.renderCall({ name: "reviewer", prompt }, {} as any, { lastComponent: undefined }));

    expect(rendered).toContain("subagent reviewer");
    expect(rendered).toContain("mode: new session");
    expect(rendered).toContain("prompt preview");
    expect(rendered).toContain("line one");
    expect(rendered).toContain("line two");
    expect(rendered).toContain("line three");
  });
  it("shows resume mode and falls back to raw results when details are missing", () => {
    const registry = createToolRegistry();
    registerSubagentTool(registry.pi as any, {
      executor: async () => ({ content: [{ type: "text", text: "raw output" }] }) as any,
    });

    const tool = registry.getTool("subagent");
    const call = render(tool.renderCall({ name: "coder", prompt: "full prompt", session_id: "s_1" }, {} as any, { lastComponent: undefined }));
    expect(call).toContain("mode: resume s_1");
    const result = render(tool.renderResult(
      { content: [{ type: "text", text: "raw output" }] },
      { expanded: false },
      {} as any,
      { lastComponent: undefined, isError: false },
    ));
    expect(result).toContain("raw output");
  });

  it("shows the recent tail snapshot in collapsed renderResult and raw content when expanded", () => {
    const registry = createToolRegistry();
    registerSubagentTool(registry.pi as any, {
      executor: async () => ({ content: [{ type: "text", text: "session_id: s1\n\nfull output" }], details: { sessionId: "s1", mode: "resume", name: "reviewer", status: "completed", tailLines: ["tail-1", "tail-2"], summary: "tail-2" } }),
    });

    const tool = registry.getTool("subagent");
    const collapsed = render(tool.renderResult(
      { content: [{ type: "text", text: "session_id: s1\n\nfull output" }], details: { sessionId: "s1", mode: "resume", name: "reviewer", status: "completed", tailLines: ["tail-1", "tail-2"], summary: "tail-2" } },
      { expanded: false },
      {} as any,
      { lastComponent: undefined },
    ));
    expect(collapsed).toContain("subagent result reviewer");
    expect(collapsed).toContain("session_id: s1");
    expect(collapsed).toContain("tail-1");
    expect(collapsed).toContain("tail-2");

    const expanded = render(tool.renderResult(
      { content: [{ type: "text", text: "session_id: s1\n\nfull output" }], details: { sessionId: "s1", mode: "resume", name: "reviewer", status: "completed", tailLines: ["tail-1"], summary: "tail-1" } },
      { expanded: true },
      {} as any,
      { lastComponent: undefined, isError: false },
    ));
    expect(expanded).toContain("full output");
  });

  it("propagates executor failures as error results", async () => {
    const registry = createToolRegistry();
    registerSubagentTool(registry.pi as any, {
      executor: async () => {
        throw new Error("boom");
      },
    });

    const tool = registry.getTool("subagent");
    const result = await tool.execute("call-1", { name: "reviewer", prompt: "Review" }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Error: boom");
    expect(result.details.summary).toBe("boom");
  });
  it("normalizes blank session ids before calling the executor", async () => {
    const registry = createToolRegistry();
    let seenSessionId: string | undefined = "not-set";
    registerSubagentTool(registry.pi as any, {
      executor: async (options) => {
        seenSessionId = options.sessionId;
        return { content: [{ type: "text", text: "ok" }], details: { mode: "new", name: options.name, status: "completed", tailLines: ["ok"], summary: "ok" } } as any;
      },
    });

    const tool = registry.getTool("subagent");
    const result = await tool.execute("call-2", { name: "reviewer", prompt: "Review", session_id: "   " }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).not.toBe(true);
    expect(seenSessionId).toBeUndefined();
  });
});
