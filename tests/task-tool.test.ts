import { describe, expect, it } from "vitest";
import { buildTaskErrorResult, formatTaskCallText, formatTaskResultSummaryText, parseTaskParams } from "../src/task/task-format.js";
import { registerTaskTool } from "../src/task/tool.js";
import { createToolRegistry } from "./helpers.js";

function render(component: any): string {
  return component.render(200).join("\n");
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const styledTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};

describe("task tool formatters", () => {
  it("formats calls and result summaries directly", () => {
    const call = formatTaskCallText(parseTaskParams({ subagent: "coder", prompt: "full prompt", session_id: "s1" }), theme);
    expect(call).toContain("task coder");
    expect(call).toContain("mode: resume s1");
    expect(call).toContain("full prompt");

    const summary = formatTaskResultSummaryText({
      sessionId: "s1",
      mode: "resume",
      name: "reviewer",
      status: "completed",
      tailLines: ["line-1", "line-2"],
      summary: "line-2",
    }, theme);
    expect(summary).toContain("task result reviewer");
    expect(summary).toContain("line-2");
    expect(summary).toContain("line-2");
  });
  it("handles missing values in formatter helpers", () => {
    const call = formatTaskCallText(parseTaskParams({ prompt: 123, session_id: "   " }), theme);
    expect(call).toContain("task <missing-subagent>");
    expect(call).toContain("mode: new session");
    expect(call).toContain("123");

    const summary = formatTaskResultSummaryText({
      mode: "new",
      name: "reviewer",
      status: "failed",
      tailLines: ["error line"],
      summary: "error line",
    }, theme);
    expect(summary).toContain("status: failed");
    expect(summary).not.toContain("session_id:");

    const errorResult = buildTaskErrorResult(parseTaskParams({ subagent: "reviewer", prompt: "x", session_id: "s1" }), "boom");
    expect(errorResult.isError).toBe(true);
    expect(errorResult.details.sessionId).toBe("s1");
  });
  it("styles failed summaries as errors and surfaces the failure reason", () => {
    const summary = formatTaskResultSummaryText({
      mode: "new",
      name: "reviewer",
      status: "failed",
      tailLines: ["User:", "Inspect the diff", "Error: invalid api key"],
      summary: "Error: invalid api key",
      error: "invalid api key",
    }, styledTheme);

    expect(summary).toContain("<error><b>task result</b></error> <accent>reviewer</accent>");
    expect(summary).toContain("<muted>status:</muted> <error>failed</error>");
    expect(summary).toContain("<error>Error: invalid api key</error>");
  });
});

describe("task tool", () => {
  it("renders full prompt previews in renderCall", () => {
    const registry = createToolRegistry();
    registerTaskTool(registry.pi as any, {
      executor: async () => ({ content: [{ type: "text", text: "unused" }], details: { mode: "new", name: "coder", status: "completed", tailLines: ["done"], summary: "done" } }),
    });

    const tool = registry.getTool("task");
    const prompt = "line one\nline two\nline three";
    const rendered = render(tool.renderCall({ subagent: "reviewer", prompt }, {} as any, { lastComponent: undefined }));

    expect(rendered).toContain("task reviewer");
    expect(rendered).toContain("mode: new session");
    expect(rendered).toContain("prompt preview");
    expect(rendered).toContain("line one");
    expect(rendered).toContain("line two");
    expect(rendered).toContain("line three");
  });

  it("shows resume mode and falls back to raw results when details are missing", () => {
    const registry = createToolRegistry();
    registerTaskTool(registry.pi as any, {
      executor: async () => ({ content: [{ type: "text", text: "raw output" }] }) as any,
    });

    const tool = registry.getTool("task");
    const call = render(tool.renderCall({ subagent: "coder", prompt: "full prompt", session_id: "s_1" }, {} as any, { lastComponent: undefined }));
    expect(call).toContain("mode: resume s_1");
    const result = render(tool.renderResult(
      { content: [{ type: "text", text: "raw output" }] },
      { expanded: false },
      {} as any,
      { lastComponent: undefined, isError: false },
    ));
    expect(result).toContain("raw output");
  });
  it("falls back to raw results for expanded renders without details", () => {
    const registry = createToolRegistry();
    registerTaskTool(registry.pi as any, {
      executor: async () => ({ content: [{ type: "text", text: "raw expanded" }] }) as any,
    });

    const tool = registry.getTool("task");
    const result = render(tool.renderResult(
      { content: [{ type: "text", text: "raw expanded" }] },
      { expanded: true },
      {} as any,
      { lastComponent: undefined, isError: false },
    ));
    expect(result).toContain("raw expanded");
  });

  it("shows the recent tail snapshot in collapsed renderResult and a structured transcript when expanded", () => {
    const registry = createToolRegistry();
    registerTaskTool(registry.pi as any, {
      executor: async () => ({ content: [{ type: "text", text: "session_id: s1\n\nfull output" }], details: { sessionId: "s1", mode: "resume", name: "reviewer", status: "completed", tailLines: ["tail-1", "tail-2"], summary: "tail-2", transcriptLines: ["User:", "Inspect the file", "───", "Tool Result:", "name: read", "content:", "full output"] } }),
    });

    const tool = registry.getTool("task");
    const collapsed = render(tool.renderResult(
      { content: [{ type: "text", text: "session_id: s1\n\nfull output" }], details: { sessionId: "s1", mode: "resume", name: "reviewer", status: "completed", tailLines: ["tail-1", "tail-2"], summary: "tail-2", transcriptLines: ["User:", "Inspect the file", "───", "Tool Result:", "name: read", "content:", "full output"] } },
      { expanded: false },
      {} as any,
      { lastComponent: undefined },
    ));
    expect(collapsed).toContain("task result reviewer");
    expect(collapsed).toContain("session_id: s1");
    expect(collapsed).toContain("tail-1");
    expect(collapsed).toContain("tail-2");

    const expanded = render(tool.renderResult(
      { content: [{ type: "text", text: "session_id: s1\n\nfull output" }], details: { sessionId: "s1", mode: "resume", name: "reviewer", status: "completed", tailLines: ["tail-1"], summary: "tail-1", transcriptLines: ["User:", "Inspect the file", "───", "Tool Result:", "name: read", "content:", "full output"] } },
      { expanded: true },
      {} as any,
      { lastComponent: undefined, isError: false },
    ));
    expect(expanded).toContain("Subagent Session:");
    expect(expanded).toContain("Transcript:");
    expect(expanded).toContain("Tool Result:");
    expect(expanded).toContain("full output");
  });
  it("reuses the previous text component for collapsed summaries", () => {
    const registry = createToolRegistry();
    registerTaskTool(registry.pi as any, {
      executor: async () => ({ content: [{ type: "text", text: "unused" }], details: { mode: "new", name: "reviewer", status: "completed", tailLines: ["tail"], summary: "tail" } }) as any,
    });

    const tool = registry.getTool("task");
    const previous = tool.renderResult(
      { content: [{ type: "text", text: "unused" }], details: { mode: "new", name: "reviewer", status: "completed", tailLines: ["tail"], summary: "tail" } },
      { expanded: false },
      {} as any,
      { lastComponent: undefined },
    );
    const reused = tool.renderResult(
      { content: [{ type: "text", text: "unused" }], details: { mode: "new", name: "reviewer", status: "completed", tailLines: ["tail-2"], summary: "tail-2" } },
      { expanded: false },
      {} as any,
      { lastComponent: previous },
    );
    expect(reused).toBe(previous);
    expect(render(reused)).toContain("tail-2");
  });

  it("propagates executor failures as error results", async () => {
    const registry = createToolRegistry();
    registerTaskTool(registry.pi as any, {
      executor: async () => {
        throw new Error("boom");
      },
    });

    const tool = registry.getTool("task");
    const result = await tool.execute("call-1", { subagent: "reviewer", prompt: "Review" }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("subagent reviewer run failed.");
    expect(result.content[0]?.text).toContain("error:");
    expect(result.content[0]?.text).toContain("boom");
    expect(result.details.summary).toBe("boom");
  });
  it("includes session_id in executor failure output when resuming", async () => {
    const registry = createToolRegistry();
    registerTaskTool(registry.pi as any, {
      executor: async () => {
        throw new Error("resume boom");
      },
    });

    const tool = registry.getTool("task");
    const result = await tool.execute("call-1", { subagent: "reviewer", prompt: "Review", session_id: "s-resume" }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("session_id: `s-resume`");
    expect(result.details.sessionId).toBe("s-resume");
  });

  it("normalizes blank session ids before calling the executor", async () => {
    const registry = createToolRegistry();
    let seenSessionId: string | undefined = "not-set";
    registerTaskTool(registry.pi as any, {
      executor: async (options) => {
        seenSessionId = options.sessionId;
        return { content: [{ type: "text", text: "ok" }], details: { mode: "new", name: options.name, status: "completed", tailLines: ["ok"], summary: "ok" } } as any;
      },
    });

    const tool = registry.getTool("task");
    const result = await tool.execute("call-2", { subagent: "reviewer", prompt: "Review", session_id: "   " }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).not.toBe(true);
    expect(seenSessionId).toBeUndefined();
  });
  it("forwards signal, context, and update callback to the executor", async () => {
    const registry = createToolRegistry();
    const signal = new AbortController().signal;
    const updates: any[] = [];
    let seen: any;
    registerTaskTool(registry.pi as any, {
      executor: async (options) => {
        seen = options;
        return { content: [{ type: "text", text: "ok" }], details: { mode: "new", name: options.name, status: "completed", tailLines: ["ok"], summary: "ok" } } as any;
      },
    });

    const tool = registry.getTool("task");
    const ctx = { cwd: process.cwd(), custom: true };
    await tool.execute("call-2", { subagent: "reviewer", prompt: "Review" }, signal, (partial: any) => updates.push(partial), ctx as any);
    expect(seen.signal).toBe(signal);
    expect(seen.ctx).toBe(ctx);
    expect(typeof seen.onUpdate).toBe("function");
    expect(updates).toEqual([]);
  });

  it("validates required subagent and prompt arguments before invoking the executor", async () => {
    const registry = createToolRegistry();
    let called = false;
    registerTaskTool(registry.pi as any, {
      executor: async () => {
        called = true;
        return { content: [{ type: "text", text: "ok" }], details: { mode: "new", name: "reviewer", status: "completed", tailLines: ["ok"], summary: "ok" } } as any;
      },
    });

    const tool = registry.getTool("task");
    const missingSubagent = await tool.execute("call-3", { subagent: "   ", prompt: "Review" }, undefined, undefined, { cwd: process.cwd() });
    expect(missingSubagent.isError).toBe(true);
    expect(missingSubagent.content[0]?.text).toContain("task requires a non-empty `subagent` argument.");

    const missingPrompt = await tool.execute("call-4", { subagent: "reviewer", prompt: "   " }, undefined, undefined, { cwd: process.cwd() });
    expect(missingPrompt.isError).toBe(true);
    expect(missingPrompt.content[0]?.text).toContain("task requires a non-empty `prompt` argument.");
    expect(called).toBe(false);
  });
});
