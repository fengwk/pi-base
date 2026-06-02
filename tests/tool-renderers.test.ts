import { describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { createToolRegistry } from "./helpers.js";

function render(component: any): string {
  return component.render(200).join("\n");
}

describe("tool renderers", () => {
  it("renders calls and results for tools that pi-base customizes", () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    // `find` is delegated to the built-in pi-coding-agent tool, so its renderer
    // is owned upstream and not asserted here. The remaining tools are wrapped
    // by pi-base and need consistent opencode-style call rendering.
    const cases = [
      { name: "read", args: { path: "src/example.ts", offset: 2, limit: 5 } },
      { name: "grep", args: { pattern: "demo", path: "src", include: "*.ts" } },
      { name: "bash", args: { command: "pwd", workdir: ".", timeoutSeconds: 5 } },
      {
        name: "edit",
        args: {
          path: "src/example.ts",
          edits: [
            { replace_lines: { start_anchor: "1:abc", end_anchor: "1:abc", new_text: "const a = 1;" } },
            { delete_lines: { start_anchor: "2:def", end_anchor: "3:ghi" } },
            { insert_before: { anchor: "4:jkl", new_text: "before" } },
            { insert_after: { anchor: "5:mno", new_text: "after" } },
            { unexpected: true },
          ],
        },
      },
      { name: "write", args: { path: "src/example.ts", content: "export const x = 1;" } },
      { name: "lsp_diagnostics", args: { path: "src/example.ts", severity: "error" } },
      { name: "lsp_goto_definition", args: { path: "src/example.ts", line: 2, character: 0 } },
      { name: "lsp_workspace_symbols", args: { path: "src/example.ts", query: "Example", limit: 10 } },
      { name: "lsp_java_decompile", args: { path: "src/App.java", target: "jdt://demo" } },
    ];

    for (const testCase of cases) {
      const tool = registry.getTool(testCase.name);
      const call = render(tool.renderCall(testCase.args, {} as any, { lastComponent: undefined }));
      const result = render(tool.renderResult({ content: [{ type: "text", text: "line-1\nline-2" }] }, { expanded: false, isPartial: false }, {} as any, { lastComponent: undefined }));
      expect(call.length).toBeGreaterThan(0);
      expect(result).toContain("line-1");
    }
  });

  it("renders calls in concise opencode style for pi-base-wrapped tools", () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const expectations = [
      { name: "read", args: { path: "/home/fengwk/proj/pi-base/src/edit.ts", offset: 150, limit: 110 }, expected: "Read ~/proj/pi-base/src/edit.ts [offset=150, limit=110]" },
      { name: "grep", args: { pattern: "demo", path: "src", include: "*.ts" }, expected: "grep demo in src [include=*.ts]" },
      { name: "bash", args: { command: "npm test", workdir: ".", timeoutSeconds: 5 }, expected: "$ npm test in . [timeoutSeconds=5]" },
      { name: "write", args: { path: "src/example.ts", content: "export const x = 1;" }, expected: "write src/example.ts" },
      { name: "lsp_diagnostics", args: { path: "src/example.ts", severity: "error" }, expected: "lsp_diagnostics src/example.ts [severity=error]" },
      { name: "lsp_goto_definition", args: { path: "src/example.ts", line: 2 }, expected: "lsp_goto_definition src/example.ts [line=2, character=0]" },
      { name: "lsp_workspace_symbols", args: { path: "src/example.ts", query: "Example", limit: 10 }, expected: "lsp_workspace_symbols src/example.ts Example [limit=10]" },
      { name: "lsp_java_decompile", args: { path: "src/App.java", target: "jdt://demo" }, expected: "lsp_java_decompile src/App.java jdt://demo" },
    ];

    for (const testCase of expectations) {
      const tool = registry.getTool(testCase.name);
      const call = render(tool.renderCall(testCase.args, {} as any, { lastComponent: undefined }));
      expect(call).toContain(testCase.expected);
    }
  });
});
