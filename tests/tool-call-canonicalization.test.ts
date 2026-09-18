import { describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { canonicalizeAssistantToolCalls } from "../src/tool-call-canonicalization.js";
import { createToolRegistry } from "./helpers.js";

function assistantMessage(toolName: string, args: unknown) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Inspect the workspace." },
      { type: "toolCall", id: "call-1", name: toolName, arguments: args },
    ],
    stopReason: "toolUse",
    timestamp: 1,
  };
}

describe("tool-call canonicalization", () => {
  it("rewrites an exact empty read call to the existing current-directory fallback", () => {
    // Intent: the persisted assistant call must match the arguments that read already executes,
    // preventing an empty call from becoming a repeated in-context example.
    const original = assistantMessage("read", {});
    const canonical = canonicalizeAssistantToolCalls(original);

    expect(canonical).not.toBe(original);
    expect(canonical.content[0]).toBe(original.content[0]);
    expect(canonical.content[1]).toEqual({
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "." },
    });
    expect(original.content[1]).toMatchObject({ arguments: {} });
  });

  it.each([
    "read",
    "grep",
    "find",
    "edit",
    "write",
    "lsp_goto_definition",
    "lsp_workspace_symbols",
    "lsp_java_decompile",
  ])("persists the existing filePath alias as path for %s", (toolName) => {
    // Intent: message history and execution must use the same canonical key for every tool
    // that already accepts the observed file-path aliases through prepareArguments.
    const canonical = canonicalizeAssistantToolCalls(
      assistantMessage(toolName, { filePath: "src/example.ts", limit: 1 }),
    );

    expect(canonical.content[1]).toMatchObject({
      name: toolName,
      arguments: { path: "src/example.ts", limit: 1 },
    });
  });

  it("does not infer missing arguments for partial read calls or unrelated tools", () => {
    // Intent: only observed compatibility rules are canonicalized; incomplete calls that require
    // semantic guessing must still reach normal validation unchanged.
    const partialRead = assistantMessage("read", { limit: 1 });
    const unrelated = assistantMessage("bash", { filePath: "script.sh" });

    expect(canonicalizeAssistantToolCalls(partialRead)).toBe(partialRead);
    expect(canonicalizeAssistantToolCalls(unrelated)).toBe(unrelated);
  });

  it("registers the canonicalization on the provider-independent message_end event", async () => {
    // Intent: using message_end makes the replacement part of Pi's agent state and persisted
    // session rather than changing only one provider request or one execution.
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const original = assistantMessage("read", {});

    const result = await registry.emit("message_end", {
      type: "message_end",
      message: original,
    });

    expect(result?.message.content[1]).toMatchObject({
      id: "call-1",
      name: "read",
      arguments: { path: "." },
    });
  });
});
