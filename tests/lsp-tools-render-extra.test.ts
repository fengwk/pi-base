import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { registerLspTools } from "../src/lsp/tools.js";
import { lspManager } from "../src/lsp/client.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

function render(component: any): string {
  return component.render(200).join("\n");
}

describe("lsp tool render and branch coverage", () => {
  it("renders call previews with missing workdir fallbacks", () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);

    const diagnostics = render(registry.getTool("lsp_diagnostics").renderCall({ path: "src/example.ts", severity: "warning" }, {} as any, { lastComponent: undefined }));
    expect(diagnostics).toContain("lsp_diagnostics src/example.ts in <missing-workdir>");

    const gotoDefinition = render(registry.getTool("lsp_goto_definition").renderCall({ path: "src/example.ts", line: 3 }, {} as any, { lastComponent: undefined }));
    expect(gotoDefinition).toContain("[line=3, character=0]");

    const symbols = render(registry.getTool("lsp_workspace_symbols").renderCall({ path: "src/example.ts", query: "Example" }, {} as any, { lastComponent: undefined }));
    expect(symbols).toContain("lsp_workspace_symbols src/example.ts in <missing-workdir> Example");

    const decompile = render(registry.getTool("lsp_java_decompile").renderCall({ path: "src/App.java", target: "jdt://demo" }, {} as any, { lastComponent: undefined }));
    expect(decompile).toContain("lsp_java_decompile src/App.java in <missing-workdir> jdt://demo");
  });

  it("supports workspace symbol errors and java decompile fallbacks", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => ({
      serverId: () => "mock-server",
      supportsMethod: (method: string) => method === "java/classFileContents",
      workspaceSymbols: async () => [],
      classFileContents: async () => "",
      decompileClass: async () => "",
      diagnostics: async () => [],
      definition: async () => [],
    } as any);

    try {
      const unsupportedSymbols = await registry.getTool("lsp_workspace_symbols").execute(
        "1",
        { workdir: ".", path: "src/example.ts", query: "Symbol" },
        undefined,
        undefined,
        { cwd: process.cwd() },
      );
      expect(unsupportedSymbols.isError).toBe(true);
      expect(getText(unsupportedSymbols)).toContain("does not advertise workspace/symbol support");

      const unsupportedJava = await registry.getTool("lsp_java_decompile").execute(
        "2",
        { workdir: ".", path: "src/App.java", target: "Demo.class" },
        undefined,
        undefined,
        { cwd: process.cwd() },
      );
      expect(unsupportedJava.isError).toBe(true);
      expect(getText(unsupportedJava)).toContain("Could not decompile class");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("normalizes file:// java decompile targets before asking the client", async () => {
    const root = await createTempWorkspace();
    const classPath = await writeWorkspaceFile(root, "build/Demo.class", "compiled");
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    let seenTarget: string | undefined;
    lspManager.getClient = async () => ({
      serverId: () => "mock-server",
      supportsMethod: (method: string) => method === "java/classFileContents",
      classFileContents: async () => null,
      decompileClass: async (targetUri: string) => {
        seenTarget = targetUri;
        return "decompiled";
      },
      diagnostics: async () => [],
      definition: async () => [],
      workspaceSymbols: async () => [],
    } as any);

    try {
      const target = pathToFileURL(classPath).href;
      const result = await registry.getTool("lsp_java_decompile").execute(
        "1",
        { workdir: ".", path: "src/App.java", target },
        undefined,
        undefined,
        { cwd: root },
      );
      expect(getText(result)).toBe("decompiled");
      expect(seenTarget).toBe(target);
    } finally {
      lspManager.getClient = original;
    }
  });
});
