import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { createToolRegistry } from "./helpers.js";

const registry = createToolRegistry();
piBaseExtension(registry.pi as never);

function validate(name: string, args: Record<string, unknown>) {
  const tool = registry.getTool(name);
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  return validateToolArguments(tool, {
    type: "toolCall", id: `schema-${name}`, name, arguments: prepared,
  }) as Record<string, unknown>;
}

describe("tool schemas with Pi's argument validator", () => {
  // Pi 1.5 replaces TypeBox validation with pi-schema. Validate each registered schema
  // through the public host API, rather than calling execute() and bypassing validation.
  it.each<[string, Record<string, unknown>]>([
    ["read", { path: "example.ts" }],
    ["write", { path: "example.ts", content: "text" }],
    ["edit", { path: "example.ts", old_string: "old", new_string: "new" }],
    ["apply_patch", { patchText: "*** Begin Patch\n*** End Patch\n" }],
    ["bash", { command: "pwd" }],
    ["grep", { pattern: "text", path: "." }],
    ["find", { pattern: "*.ts", path: "." }],
    ["lsp_goto_definition", { path: "example.ts", line: 1 }],
    ["lsp_workspace_symbols", { path: "example.ts", query: "Example" }],
    ["lsp_java_decompile", { path: "Example.java", target: "jdt://example" }],
    ["task", { subagent_type: "coder", prompt: "Inspect the file." }],
    ["create_goal", { objective: "Verify compatibility." }],
    ["get_goal", {}],
    ["update_goal", { status: "complete", reason: "Verification passed." }],
  ])("accepts the registered %s JSON Schema", (name, args) => {
    expect(validate(name, args)).toEqual(args);
  });

  it("preserves aliases, numeric coercion and optional-null handling", () => {
    // Intent: prepareArguments still precedes validation, and parsers must receive usable
    // values regardless of whether Pi preserves a numeric string in a number|string union.
    const input = { file_path: "example.ts", offset: "2", limit: null };
    const read = validate("read", input);
    expect(read.path).toBe("example.ts");
    expect(Number(read.offset)).toBe(2);
    expect(read.limit).toBeUndefined();
    expect(input).toEqual({ file_path: "example.ts", offset: "2", limit: null });
    expect(validate("lsp_goto_definition", { path: "example.ts", line: "3" }).line).toBe(3);
    expect(validate("task", { subagent_type: "coder", prompt: "Inspect.", max_turns: "2" }).max_turns).toBe(2);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["find", { pattern: "*.ts" }, "path"],
    ["task", { subagent_type: "coder", prompt: "Inspect.", max_turns: 0 }, "max_turns"],
    ["apply_patch", { patchText: "patch", unexpected: true }, "unexpected"],
  ])("rejects invalid %s arguments without depending on TypeBox error wording", (name, args, field) => {
    // Intent: required, numeric-bound and additionalProperties constraints must survive the
    // validator migration; only the stable error prefix and field matter, not legacy messages.
    expect(() => validate(name, args)).toThrow(/Validation failed for tool/);
    expect(() => validate(name, args)).toThrow(field);
  });
});
