import { describe, expect, it } from "vitest";
import { describeShellFor, loadBashDescription, loadBashPromptSnippet } from "../src/bash-renderer-core.js";
import { editSchema } from "../src/schemas/edit.js";
import { findSchema } from "../src/schemas/find.js";
import { grepSchema } from "../src/schemas/grep.js";
import { lspGotoDefinitionSchema, lspJavaDecompileSchema, lspWorkspaceSymbolsSchema } from "../src/schemas/lsp.js";
import { readSchema } from "../src/schemas/read.js";
import { writeSchema } from "../src/schemas/write.js";
import { createTaskSchema } from "../src/subagent/schema.js";
import { loadToolDescription } from "../src/tool-prompt.js";

function descriptionOf(schema: unknown): string | undefined {
  return (schema as { description?: string }).description;
}

describe("tool prompt loading", () => {
  it("substitutes every bash placeholder in both the description and the snippet", () => {
    // Intent: loadToolDescription wraps each key as `${key}`, so callers must pass bare names.
    // Passing pre-wrapped `${shell}` keys silently leaves raw placeholders in model-visible text.
    const description = loadBashDescription();
    const shell = describeShellFor({ platform: process.platform, shellPath: process.env.SHELL });
    expect(description).not.toMatch(/\$\{[^}]*\}/);
    expect(description).toContain(`Shell: ${shell}`);
    expect(description).not.toContain("- OS:");
    expect(description).not.toContain("- Note:");
    expect(description).not.toContain("WSL environment.");
    expect(description).not.toContain("Windows files may be accessible under /mnt/<drive>");
    expect(description).not.toContain("Windows commands may be invocable from WSL");
    expect(loadBashPromptSnippet()).not.toMatch(/\$\{[^}]*\}/);
  });

  it("replaces named placeholders in tool descriptions", () => {
    // Intent: prompt snippets use `${name}` placeholders; replacement must use
    // the actual key, not the literal word "placeholder".
    const description = loadToolDescription("bash", {
      shell: "TestShell",
    });

    expect(description).toContain("Shell: TestShell");
    expect(description).not.toContain("${shell}");
  });

  it("uses one workdir contract for every path-based tool schema", () => {
    // Intent: a stable shared description lets the model transfer one workdir concept across tools.
    const expected = "Working directory for resolving relative paths. Defaults to the agent's current working directory. If provided, relative paths resolve from that directory.";
    const schemas = [
      readSchema,
      editSchema,
      writeSchema,
      findSchema,
      grepSchema,
      lspGotoDefinitionSchema,
      lspWorkspaceSymbolsSchema,
      lspJavaDecompileSchema,
    ];

    for (const schema of schemas) {
      expect(descriptionOf(schema.properties.workdir)).toBe(expected);
    }
  });

  it("keeps edit and task parameter guidance in their schemas", () => {
    // Intent: removing duplicated Parameters sections must not remove constraints needed to call the tools correctly.
    const replacement = editSchema.properties.edits.items;
    expect(descriptionOf(replacement.properties.old_string)).toContain("non-empty");
    expect(descriptionOf(replacement.properties.old_string)).toContain("exactly once");
    expect(descriptionOf(replacement.properties.new_string)).toContain("may be empty");

    const taskSchema = createTaskSchema(7);
    expect(descriptionOf(taskSchema.properties.subagent_type)).toContain("<available_subagents>");
    expect(descriptionOf(taskSchema.properties.prompt)).toContain("self-contained");
    expect(descriptionOf(taskSchema.properties.max_turns)).toContain("Defaults to 7");
    expect(descriptionOf(taskSchema.properties.session_id)).toContain("<task id=");
  });

  it("explains snapshot edits and ordering without introducing another calling convention", () => {
    // Intent: the approved prompt must reach the model with batching, snapshot matching and cross-call boundaries intact.
    const description = loadToolDescription("edit");
    expect(description).toContain("prefer one `edit` call for independent changes to the same file");
    expect(description).toContain("original file, not earlier entries' output");
    expect(description).toContain("any validation failure reject the entire call before writing");
    expect(description).toContain("a later failure does not roll back earlier successful calls");
    expect(description).toContain("Wait for the preceding call to finish before issuing a dependent one");
  });

  it("describes the shared replacement-decoded text workflow", () => {
    // Intent: model-visible prompts must match read output without a path header and
    // the approved shared decoding semantics for read, edit, and grep.
    const read = loadToolDescription("read");
    expect(read).toContain("(`ends_with_newline` and `lsp`)");
    expect(read).not.toContain("(`path`, `ends_with_newline`");
    expect(read).toContain("Text is decoded using its byte order mark or standard encoding declaration, otherwise as UTF-8.");
    expect(read).toContain("Invalid byte sequences appear as U+FFFD (�); read and edit use the same decoded text.");
    expect(read).not.toContain("declares no encoding is refused");

    const edit = loadToolDescription("edit");
    expect(edit).toContain("(`ends_with_newline` and `lsp`)");
    expect(edit).not.toContain("(`path`, `ends_with_newline`");

    const grep = loadToolDescription("grep");
    expect(grep).toContain("Searches use the same decoded text as read, including U+FFFD (�) for invalid byte sequences.");
    expect(grep).toContain("A final Not searched notice lists files that could not be searched; their contents were not checked.");
    expect(grep).not.toContain("could not be determined");
  });

  it("keeps structured parameters out of ordinary tool prose", () => {
    // Intent: schemas own structured parameter documentation for every registered tool.
    const schemaOwnedTools = [
      "read",
      "bash",
      "edit",
      "write",
      "find",
      "grep",
      "lsp_goto_definition",
      "lsp_workspace_symbols",
      "lsp_java_decompile",
      "task",
    ];

    for (const name of schemaOwnedTools) {
      expect(loadToolDescription(name)).not.toContain("\nParameters:");
    }
  });
});
