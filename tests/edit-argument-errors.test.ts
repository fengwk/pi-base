import { parseToolCallArguments, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerEditTool } from "../src/edit.js";
import { createToolRegistry, getText } from "./helpers.js";

const malformedArguments = '{"path":"example.svg","edits":[{"old_string":"old","new_string":"<svg width="240">"}]}';

async function runEdit(rawArguments: string) {
  const registry = createToolRegistry();
  registerEditTool(registry.pi as never);
  const tool = registry.getTool("edit");
  const execute = vi.spyOn(tool, "execute");
  const call: ToolCall = {
    type: "toolCall",
    id: "edit-arguments",
    name: "edit",
    ...parseToolCallArguments(rawArguments),
  };
  const message: AssistantMessage = {
    role: "assistant",
    content: [call],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
  const outcome = await runToolCall(call, {
    tools: [tool],
    assistantMessage: message,
    context: { messages: [message], tools: [tool] },
  });
  return { tool, call, execute, outcome };
}

function createRow(tool: ConstructorParameters<typeof ToolExecutionComponent>[4], call: ToolCall) {
  return new ToolExecutionComponent(
    "edit", call.id, call.arguments, { showImages: false }, tool,
    { requestRender: () => undefined } as never, process.cwd(),
  );
}

function render(row: ToolExecutionComponent): string {
  return row.render(200).join("\n");
}

describe("edit argument errors", () => {
  it("returns the original JSON parsing error through the host without executing edit", async () => {
    // A real parser failure carries {} plus argumentsError; local validation must not mask it.
    const { call, execute, outcome } = await runEdit(malformedArguments);
    expect(call.arguments).toEqual({});
    expect(call.argumentsError).toContain("Received arguments:");
    expect(outcome.isError).toBe(true);
    expect(getText(outcome.result)).toBe(`Invalid arguments for tool "edit": ${call.argumentsError}`);
    expect(getText(outcome.result)).toContain(malformedArguments);
    expect(getText(outcome.result)).not.toContain("path: missing");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([false, true])("shows invalid JSON instead of a missing path in the real tool row (history=%s)", async (history) => {
    // Cover both live settlement and history rows where argsComplete may never be set.
    const { tool, call, outcome } = await runEdit(malformedArguments);
    const row = createRow(tool, call);
    expect(render(row)).not.toContain("<missing-path>");
    expect(render(row)).not.toContain("invalid JSON");
    if (!history) {
      row.setArgsComplete();
      row.markExecutionStarted();
    }
    row.updateResult({ ...outcome.result, isError: outcome.isError });
    await Promise.resolve();

    const collapsed = render(row);
    expect(collapsed).toContain("[invalid JSON arguments]");
    expect(collapsed).not.toContain("<missing-path>");
    expect(collapsed).toContain('Invalid arguments for tool "edit":');
    row.setExpanded(true);
    expect(render(row)).toContain(malformedArguments);
  });

  it("does not label an aborted argument stream as invalid parameters", () => {
    // An abort can settle an empty row without any schema or JSON validation error.
    const registry = createToolRegistry();
    const tool = registerEditTool(registry.pi as never);
    const row = createRow(tool, { type: "toolCall", id: "aborted-edit", name: "edit", arguments: {} });
    row.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true });
    const displayed = render(row);
    expect(displayed).toContain("Operation aborted");
    expect(displayed).not.toContain("invalid arguments");
    expect(displayed).not.toContain("<missing-path>");
  });

  it("still rejects a genuinely empty object as missing fields, not malformed JSON", async () => {
    // Deferring {} to host validation must not accept empty calls or misdiagnose valid JSON.
    const { tool, call, execute, outcome } = await runEdit("{}");
    expect(call.argumentsError).toBeUndefined();
    expect(outcome.isError).toBe(true);
    expect(getText(outcome.result)).toContain('Validation failed for tool "edit":');
    expect(getText(outcome.result)).toContain("path: missing");
    expect(getText(outcome.result)).toContain("edits: missing");
    expect(execute).not.toHaveBeenCalled();
    const row = createRow(tool, call);
    row.updateResult({ ...outcome.result, isError: outcome.isError });
    await Promise.resolve();
    expect(render(row)).toContain("[invalid arguments]");
    expect(render(row)).not.toContain("invalid JSON");
    expect(render(row)).not.toContain("<missing-path>");
  });
});
