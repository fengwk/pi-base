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
            old_string: "const a = 1;",
            new_string: "const a = 2;",
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
        const result = render(tool.renderResult({ content: [{ type: "text", text: "line-1\nline-2" }] }, { expanded: true, isPartial: false }, {} as any, { lastComponent: undefined }));
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
      expect(findRendered).toBe("");

      const readRendered = render(registry.getTool("read").renderResult(
        { content: [{ type: "text", text: output }] },
        { expanded: false, isPartial: false },
        {} as any,
        { lastComponent: undefined, cwd: root },
      ));
      expect(readRendered).not.toContain("line-1");
      expect(readRendered).not.toContain("line-2");
      expect(readRendered).toContain("25 more lines");
    });
  });

  it("uses pi-base raw renderer for find even without explicit render config", async () => {
    await withTempGlobalPiBaseConfig({}, async (root) => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const output = Array.from({ length: 25 }, (_, index) => `line-${index + 1}`).join("\n");

      const rendered = render(registry.getTool("find").renderResult(
        { content: [{ type: "text", text: output }] },
        { expanded: false, isPartial: false },
        {} as any,
        { lastComponent: undefined, cwd: root },
      ));
      expect(rendered).toContain("line-19");
      expect(rendered).not.toContain("line-20");
      expect(rendered).toContain("6 more lines");
      expect(rendered).toContain("ctrl+o to expand");
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
        expect(rendered, toolName).not.toContain("line-1");
        expect(rendered, toolName).not.toContain("line-2");
        expect(rendered, toolName).toContain("3 more lines");
      }
    });
  });
  // Intent: edit should show the final diff in renderCall, while renderResult stays concise.
  it("shows completed edit diff in renderCall and keeps renderResult concise", async () => {
    await withTempGlobalPiBaseConfig({}, async () => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const sharedState = {};
      const diff = [
        "-1|const x = 1;",
        "+1|const x = 2;",
      ].join("\n");
      const rendered = render(registry.getTool("edit").renderResult(
        { content: [{ type: "text", text: `Edited src/a.ts successfully.\nReplacements: 1\n\ndiff:\n${diff}` }], details: { diff, replacements: 1, path: "/tmp/ws/src/a.ts" } },
        { expanded: true, isPartial: false },
        { fg: (role: string, text: string) => `<${role}>${text}</${role}>` } as any,
        { lastComponent: undefined, state: sharedState, args: { path: "src/a.ts" } },
      ));
      expect(rendered).toContain("<success>Edited src/a.ts successfully.</success>");
      expect(rendered).toContain("<muted>Replacements: 1</muted>");
      expect(rendered).not.toContain("-1|const x = 1;");
      expect(rendered).not.toContain("+1|const x = 2;");

      const callRendered = render(registry.getTool("edit").renderCall(
        { path: "src/a.ts", old_string: "const x = 1;", new_string: "const x = 2;" },
        { fg: (role: string, text: string) => `<${role}>${text}</${role}>` } as any,
        { lastComponent: undefined, state: sharedState, executionStarted: true, argsComplete: true, cwd: "/tmp/ws" },
      ));
      expect(callRendered).toContain("<toolDiffRemoved>-1|const x = 1;</toolDiffRemoved>");
      expect(callRendered).toContain("<toolDiffAdded>+1|const x = 2;</toolDiffAdded>");
    });
  });

  it("hides short successful edit summaries in collapsed mode when the line preview is disabled", async () => {
    await withTempGlobalPiBaseConfig({ render: { collapsedToolResultLines: { edit: 0 }, collapsedToolResultMaxChars: { edit: 10 } } }, async () => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const rendered = render(registry.getTool("edit").renderResult(
        { content: [{ type: "text", text: "Edited src/a.ts successfully.\nReplacements: 1\n\ndiff:\n-1|const x = 1;\n+1|const x = 2;" }], details: { diff: "-1|const x = 1;\n+1|const x = 2;", replacements: 1, path: "/tmp/ws/src/a.ts" } },
        { expanded: false, isPartial: false },
        {} as any,
        { lastComponent: undefined, state: {}, args: { path: "src/a.ts" }, cwd: "/tmp/ws" },
      ));
      expect(rendered).toBe("");
    });
  });

  // Intent: write/edit renderCall should show full input for human review when expanded or already short enough.
  it("renderCall shows full edit input and write content", async () => {
    await withTempGlobalPiBaseConfig({}, async () => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const editCall = render(registry.getTool("edit").renderCall(
        { workdir: "pkg", path: "a.ts", old_string: "old", new_string: "new" },
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

  it("colors edit call previews like diff hunks", async () => {
    await withTempGlobalPiBaseConfig({}, async () => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const rendered = render(registry.getTool("edit").renderCall(
        { path: "src/example.ts", old_string: "old", new_string: "new" },
        { fg: (role: string, text: string) => `<${role}>${text}</${role}>` } as any,
        { lastComponent: undefined, argsComplete: true, cwd: "/tmp/ws" },
      ));
      expect(rendered).toContain("<toolDiffRemoved>-old</toolDiffRemoved>");
      expect(rendered).toContain("<toolDiffAdded>+new</toolDiffAdded>");
    });
  });

  it("shows edit working state in renderCall while execution is in progress", async () => {
    await withTempGlobalPiBaseConfig({}, async () => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const rendered = render(registry.getTool("edit").renderCall(
        { path: "src/example.ts", old_string: "alpha\nbeta", new_string: "alpha\nbeta\ngamma" },
        {} as any,
        { lastComponent: undefined, state: {}, executionStarted: true, argsComplete: true, cwd: "/tmp/ws" },
      ));
      expect(rendered).toContain("working");
      expect(rendered).toContain("old 2L/10C");
      expect(rendered).toContain("new 3L/16C");
    });
  });

  it("does not keep showing edit working state after a failed result arrives", async () => {
    await withTempGlobalPiBaseConfig({}, async () => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const rendered = render(registry.getTool("edit").renderCall(
        { path: "src/example.ts", old_string: "old", new_string: "new" },
        {} as any,
        { lastComponent: undefined, state: {}, executionStarted: true, argsComplete: true, isPartial: false, cwd: "/tmp/ws" },
      ));
      expect(rendered).toContain("-old");
      expect(rendered).toContain("+new");
      expect(rendered).not.toContain("working");
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
      expect(diagnosticsRendered).not.toContain("line-2");
      expect(diagnosticsRendered).toContain("3 more lines");

      const symbolsRendered = render(registry.getTool("lsp_workspace_symbols").renderResult(
        { content: [{ type: "text", text: output }] },
        { expanded: false, isPartial: false },
        {} as any,
        { lastComponent: undefined, cwd: root },
      ));
      expect(symbolsRendered).not.toContain("line-1");
      expect(symbolsRendered).toContain("4 more lines");
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

  it("renders streaming call state consistently across pi-base tools", async () => {
    await withTempGlobalPiBaseConfig({}, async (root) => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);

      const streamingContext = {
        lastComponent: undefined,
        executionStarted: false,
        argsComplete: false,
        isPartial: true,
        expanded: false,
        isError: false,
        cwd: root,
        state: {},
      };

      const cases = [
        { name: "read", args: { offset: 1 } },
        { name: "grep", args: { pattern: "demo" } },
        { name: "find", args: { path: "src" } },
        { name: "bash", args: { timeout_seconds: 5 } },
      { name: "edit", args: { path: "src/example.ts", old_string: Array.from({ length: 14 }, (_, index) => `old-${index + 1}`).join("\n"), new_string: "new" } },
        { name: "write", args: { path: "src/example.ts", content: Array.from({ length: 14 }, (_, index) => `line-${index + 1}`).join("\n") } },
        { name: "lsp_diagnostics", args: { severity: "warning" } },
        { name: "lsp_goto_definition", args: { line: 3 } },
        { name: "lsp_workspace_symbols", args: { query: "Example" } },
        { name: "lsp_java_decompile", args: { target: "jdt://demo" } },
      ];

      for (const testCase of cases) {
        const rendered = render(registry.getTool(testCase.name).renderCall(
          testCase.args,
          {} as any,
          streamingContext as any,
        ));
        expect(rendered, testCase.name).toContain("streaming args");
      }

      const writeRendered = render(registry.getTool("write").renderCall(
        { path: "src/example.ts", content: Array.from({ length: 14 }, (_, index) => `line-${index + 1}`).join("\n") },
        {} as any,
        streamingContext as any,
      ));
      expect(writeRendered).toContain("line-14");
      expect(writeRendered).not.toContain("line-3");
      expect(writeRendered).toContain("earlier lines");

      const editRendered = render(registry.getTool("edit").renderCall(
        { path: "src/example.ts", old_string: Array.from({ length: 14 }, (_, index) => `old-${index + 1}`).join("\n"), new_string: "new" },
        {} as any,
        streamingContext as any,
      ));
      expect(editRendered).toContain("-old-14");
      expect(editRendered).toContain("streaming args");
      expect(editRendered).toContain("earlier lines");
      expect(editRendered).not.toContain("-old-3");
    });
  });

  it("expands write call to full content once args are complete", async () => {
    await withTempGlobalPiBaseConfig({}, async (root) => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);

      const write = registry.getTool("write");
      const content = Array.from({ length: 90 }, (_, index) => `line-${index + 1}`).join("\n");
      const args = { path: "novel_opening.txt", content };

      // Simulate the tool-execution loop: reuse lastComponent across renders,
      // stream first (argsComplete=false) then settle (argsComplete=true).
      let lastComponent: any;
      const renderOnce = (argsComplete: boolean) => {
        const component = write.renderCall(args, {} as any, {
          lastComponent,
          executionStarted: false,
          argsComplete,
          isPartial: !argsComplete,
          expanded: false,
          isError: false,
          cwd: root,
          state: {},
        } as any);
        lastComponent = component;
        return render(component);
      };

      // Streaming: rolling window keeps the block bounded
      const streaming = renderOnce(false);
      expect(streaming).toContain("streaming args");
      expect(streaming).toContain("earlier lines");
      expect(streaming).toContain("line-90");
      expect(streaming).not.toContain("line-3");

      // Args complete: full content is rendered, no truncation, no streaming label
      const settled = renderOnce(true);
      expect(settled).not.toContain("streaming args");
      expect(settled).not.toContain("earlier lines");
      expect(settled).toContain("line-1");
      expect(settled).toContain("line-3");
      expect(settled).toContain("line-90");
    });
  });

  it("expands write call once execution starts even if argsComplete never flips", async () => {
    await withTempGlobalPiBaseConfig({}, async (root) => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);

      const write = registry.getTool("write");
      const content = Array.from({ length: 90 }, (_, index) => `line-${index + 1}`).join("\n");
      const args = { path: "novel_opening.txt", content };

      let lastComponent: any;
      const renderOnce = (ctx: any) => {
        const component = write.renderCall(args, {} as any, { ...ctx, lastComponent, cwd: root, state: {} } as any);
        lastComponent = component;
        return render(component);
      };

      // Streaming (args incomplete, not executing) → rolling window
      const streaming = renderOnce({ argsComplete: false, executionStarted: false, isPartial: true, expanded: false });
      expect(streaming).toContain("earlier lines");
      expect(streaming).not.toContain("line-3");

      // Execution started while argsComplete is still false → must expand fully
      const executing = renderOnce({ argsComplete: false, executionStarted: true, isPartial: true, expanded: false });
      expect(executing).not.toContain("streaming args");
      expect(executing).not.toContain("earlier lines");
      expect(executing).toContain("line-1");
      expect(executing).toContain("line-3");
      expect(executing).toContain("line-90");
    });
  });

  it("expands write call when re-rendered from a stored session (isPartial=false)", async () => {
    await withTempGlobalPiBaseConfig({}, async (root) => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);

      const write = registry.getTool("write");
      const content = Array.from({ length: 90 }, (_, index) => `line-${index + 1}`).join("\n");
      const args = { path: "novel_opening.txt", content };

      // History restore: the host never calls setArgsComplete/markExecutionStarted,
      // so argsComplete and executionStarted stay false, but updateResult sets
      // isPartial=false. The call must render fully, not as a rolling window.
      const restored = render(write.renderCall(args, {} as any, {
        lastComponent: undefined,
        argsComplete: false,
        executionStarted: false,
        isPartial: false,
        expanded: false,
        isError: false,
        cwd: root,
        state: {},
      } as any));

      expect(restored).not.toContain("streaming args");
      expect(restored).not.toContain("earlier lines");
      expect(restored).toContain("line-1");
      expect(restored).toContain("line-3");
      expect(restored).toContain("line-90");
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
      { name: "edit", args: { workdir: "services/api", path: "src/example.ts", old_string: "alpha", new_string: "beta" }, expected: "edit src/example.ts in services/api" },
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
