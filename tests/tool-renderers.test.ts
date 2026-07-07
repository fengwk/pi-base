import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import piBaseExtension from "../index.js";
import { createTempWorkspace, createToolRegistry } from "./helpers.js";

function render(component: any): string {
  return component.render(200).join("\n");
}

async function withTempGlobalPiBaseConfig<T>(content: unknown, run: (root: string) => Promise<T> | T): Promise<T> {
  const previous = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  const root = await createTempWorkspace();
  const globalPath = join(root, "global-pi-base.json");
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalPath;
  try {
    await writeFile(globalPath, JSON.stringify(content), "utf8");
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
    else process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previous;
  }
}

describe("tool renderers", () => {
  it("renders calls and results for tools that pi-base customizes", async () => {
    await withTempGlobalPiBaseConfig({}, async () => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);

      const cases = [
        { name: "read", args: { path: "src/example.ts", workdir: "packages/web", offset: 2, limit: 5 } },
        { name: "grep", args: { pattern: "demo", path: "src", workdir: "services/api", include: "*.ts" } },
        { name: "bash", args: { command: "pwd", workdir: "services/api", timeout_seconds: 5 } },
        {
          name: "edit",
          args: {
            workdir: "packages/app",
            path: "src/example.ts",
            oldString: "const a = 1;",
            newString: "const a = 2;",
          },
        },
        { name: "write", args: { path: "src/example.ts", workdir: "services/api", content: "export const x = 1;" } },
        { name: "lsp_diagnostics", args: { path: "src/example.ts", workdir: "packages/web", severity: "error" } },
        { name: "lsp_goto_definition", args: { path: "src/example.ts", workdir: "services/api", line: 2, character: 0 } },
        { name: "lsp_workspace_symbols", args: { path: "src/example.ts", workdir: "packages/web", query: "Example", limit: 10 } },
        { name: "lsp_java_decompile", args: { path: "src/App.java", workdir: "services/java", target: "jdt://demo" } },
      ];

      for (const testCase of cases) {
        const tool = registry.getTool(testCase.name);
        const call = render(tool.renderCall(testCase.args, {} as any, { lastComponent: undefined }));
        const result = render(tool.renderResult({ content: [{ type: "text", text: "line-1\nline-2" }] }, { expanded: false, isPartial: false }, {} as any, { lastComponent: undefined }));
        expect(call.length).toBeGreaterThan(0);
        expect(result).toContain("line-1");
      }
    });
  });

  it("honors per-tool collapsed result line overrides from pi-base.json", async () => {
    await withTempGlobalPiBaseConfig({ render: { collapsedToolResultLines: { bash: 0, find: 0, read: 1 } } }, async (root) => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const output = Array.from({ length: 25 }, (_, index) => `line-${index + 1}`).join("\n");

      const bashRendered = render(registry.getTool("bash").renderResult(
        { content: [{ type: "text", text: output }] },
        { expanded: false, isPartial: false },
        {} as any,
        { lastComponent: undefined, args: { workdir: "." }, cwd: root, state: { startedAt: Date.now(), endedAt: Date.now() } },
      ));
      expect(bashRendered).not.toContain("line-1");
      expect(bashRendered).not.toContain("line-25");
      expect(bashRendered).toContain("25 earlier lines");

      const findRendered = render(registry.getTool("find").renderResult(
        { content: [{ type: "text", text: output }] },
        { expanded: false, isPartial: false },
        {} as any,
        { lastComponent: undefined, cwd: root },
      ));
      expect(findRendered).not.toContain("line-1");
      expect(findRendered).not.toContain("line-25");
      expect(findRendered).toContain("25 more lines");

      const readRendered = render(registry.getTool("read").renderResult(
        { content: [{ type: "text", text: output }] },
        { expanded: false, isPartial: false },
        {} as any,
        { lastComponent: undefined, cwd: root },
      ));
      expect(readRendered).toContain("line-1");
      expect(readRendered).not.toContain("line-2");
      expect(readRendered).toContain("24 more lines");
    });
  });

  it("honors collapsed result line overrides for grep, edit, and lsp result renderers", async () => {
    await withTempGlobalPiBaseConfig({ render: { collapsedToolResultLines: { grep: 1, edit: 1, lsp_diagnostics: 1 } } }, async (root) => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const output = "line-1\nline-2\nline-3";

      for (const toolName of ["grep", "edit", "lsp_diagnostics"]) {
        const rendered = render(registry.getTool(toolName).renderResult(
          { content: [{ type: "text", text: output }] },
          { expanded: false, isPartial: false },
          {} as any,
          { lastComponent: undefined, cwd: root },
        ));
        expect(rendered, toolName).toContain("line-1");
        expect(rendered, toolName).not.toContain("line-2");
        expect(rendered, toolName).toContain("2 more lines");
      }
    });
  });
  // Intent: edit success output should expose diff: so render.ts can color +/- lines for humans.
  it("colors edit diff lines in renderResult when output includes diff:", async () => {
    await withTempGlobalPiBaseConfig({}, async () => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const body = [
        "Edited src/a.ts successfully.",
        "Replacements: 1",
        "",
        "diff:",
        "-1|const x = 1;",
        "+1|const x = 2;",
      ].join("\n");
      const rendered = render(registry.getTool("edit").renderResult(
        { content: [{ type: "text", text: body }] },
        { expanded: true, isPartial: false },
        { fg: (role: string, text: string) => `<${role}>${text}</${role}>` } as any,
        { lastComponent: undefined },
      ));
      expect(rendered).toContain("<success>Edited src/a.ts successfully.</success>");
      expect(rendered).toContain("<toolDiffRemoved>-1|const x = 1;</toolDiffRemoved>");
      expect(rendered).toContain("<toolDiffAdded>+1|const x = 2;</toolDiffAdded>");
    });
  });

  // Intent: write/edit renderCall should show full input for human review (not streaming, but readable).
  it("renderCall shows full edit input and write content", async () => {
    await withTempGlobalPiBaseConfig({}, async () => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const editCall = render(registry.getTool("edit").renderCall(
        { workdir: "pkg", path: "a.ts", oldString: "old", newString: "new" },
        { fg: (role: string, text: string) => text } as any,
        { cwd: "/tmp/ws" },
      ));
      expect(editCall).toContain("edit");
      expect(editCall).toContain("a.ts");
      expect(editCall).toContain("-old");
      expect(editCall).toContain("+new");
      const writeCall = render(registry.getTool("write").renderCall(
        { path: "b.ts", content: "line1\nline2" },
        { fg: (role: string, text: string) => text } as any,
        { cwd: "/tmp/ws" },
      ));
      expect(writeCall).toContain("line1");
      expect(writeCall).toContain("line2");
    });
  });

  it("applies wildcard collapsed result line overrides", async () => {
    await withTempGlobalPiBaseConfig({ render: { collapsedToolResultLines: { "lsp_*": 1, "*_diagnostics": 2, "*": 4 } } }, async (root) => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const output = "line-1\nline-2\nline-3\nline-4";

      const diagnosticsRendered = render(registry.getTool("lsp_diagnostics").renderResult(
        { content: [{ type: "text", text: output }] },
        { expanded: false, isPartial: false },
        {} as any,
        { lastComponent: undefined, cwd: root },
      ));
      expect(diagnosticsRendered).toContain("line-1");
      expect(diagnosticsRendered).not.toContain("line-3");
      expect(diagnosticsRendered).toContain("2 more lines");

      const symbolsRendered = render(registry.getTool("lsp_workspace_symbols").renderResult(
        { content: [{ type: "text", text: output }] },
        { expanded: false, isPartial: false },
        {} as any,
        { lastComponent: undefined, cwd: root },
      ));
      expect(symbolsRendered).toContain("line-1");
      expect(symbolsRendered).not.toContain("line-2");
      expect(symbolsRendered).toContain("3 more lines");
    });
  });

  it("does not apply zero-line write result preview config to write call rendering", async () => {
    await withTempGlobalPiBaseConfig({ render: { collapsedToolResultLines: { write: 0 } } }, async (root) => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const rendered = render(registry.getTool("write").renderCall(
        { workdir: ".", path: "src/example.ts", content: "alpha" },
        {} as any,
        { lastComponent: undefined, executionStarted: true, argsComplete: true, isPartial: false, expanded: false, isError: false, cwd: root },
      ));
      expect(rendered).toContain("write src/example.ts");
      expect(rendered).toContain("alpha");
      expect(rendered).not.toContain("1 line prepared.");
      expect(rendered).not.toContain("Expand to inspect the original write payload.");
    });
  });

  it("renders calls in concise opencode style for pi-base-wrapped tools", () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const expectations = [
      { name: "read", args: { path: "/home/fengwk/proj/pi-base/src/edit.ts", workdir: ".", offset: 150, limit: 110 }, expected: "Read ~/proj/pi-base/src/edit.ts in . [offset=150, limit=110]" },
      { name: "grep", args: { pattern: "demo", path: "src", workdir: "packages/web", include: "*.ts", multiline: true }, expected: "grep \"demo\" in src from packages/web [include=*.ts, multiline=true]" },
      { name: "find", args: { pattern: "*.ts", path: "src", workdir: "packages/web" }, expected: "find *.ts in src from packages/web" },
      { name: "bash", args: { command: "npm test", workdir: "packages/web", timeout_seconds: 5 }, expected: "$ npm test (timeout 5s) in packages/web" },
      { name: "edit", args: { workdir: "services/api", path: "src/example.ts", oldString: "alpha", newString: "beta" }, expected: "edit src/example.ts in services/api" },
      { name: "write", args: { path: "src/example.ts", workdir: "services/api", content: "export const x = 1;" }, expected: "write src/example.ts in services/api" },
      { name: "lsp_diagnostics", args: { path: "src/example.ts", workdir: "packages/web", severity: "error" }, expected: "lsp_diagnostics src/example.ts in packages/web [severity=error]" },
      { name: "lsp_goto_definition", args: { path: "src/example.ts", workdir: "services/api", line: 2 }, expected: "lsp_goto_definition src/example.ts in services/api [line=2, character=0]" },
      { name: "lsp_workspace_symbols", args: { path: "src/example.ts", workdir: "packages/web", query: "Example", limit: 10 }, expected: "lsp_workspace_symbols src/example.ts in packages/web Example [limit=10]" },
      { name: "lsp_java_decompile", args: { path: "src/App.java", workdir: "services/java", target: "jdt://demo" }, expected: "lsp_java_decompile src/App.java in services/java jdt://demo" },
    ];

    for (const testCase of expectations) {
      const tool = registry.getTool(testCase.name);
      const call = render(tool.renderCall(testCase.args, {} as any, { lastComponent: undefined }));
      expect(call).toContain(testCase.expected);
    }
  });
});
