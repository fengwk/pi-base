import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerLspTools } from "../src/lsp/tools.js";
import { lspManager } from "../src/lsp/client.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

/**
 * Build a mock LSP client that supports all 4 standard LSP methods we use.
 * Tests that need to opt out of a capability pass `unsupported: [...]`.
 */
function mockLspClient(overrides: Record<string, unknown> = {}, unsupported: string[] = []): any {
  const supported = new Set(["textDocument/publishDiagnostics", "textDocument/definition", "workspace/symbol", "java/classFileContents"]);
  for (const m of unsupported) supported.delete(m);
  return {
    supportsMethod: (method: string) => supported.has(method),
    serverId: () => "mock-server",
    ...overrides,
  };
}

describe("lsp tools", () => {
  it("filters diagnostics by severity", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({
      diagnostics: async () => [
        { severity: 1, message: "type error", range: { start: { line: 1, character: 0 } } },
        { severity: 2, message: "warning", range: { start: { line: 2, character: 1 } } },
      ],
    });
    try {
      const result = await registry.getTool("lsp_diagnostics").execute("1", { workdir: ".", path: "src/example.ts", severity: "error" }, undefined, undefined, { cwd: process.cwd() });
      const text = getText(result);
      expect(text).toContain("type error");
      expect(text).not.toContain("warning");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("returns no diagnostics when the list is empty", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({ diagnostics: async () => [] });
    try {
      const result = await registry.getTool("lsp_diagnostics").execute("1", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: process.cwd() });
      expect(getText(result)).toBe("No diagnostics found");
    } finally {
      lspManager.getClient = original;
    }
  });
  it("handles a non-aborted diagnostics signal", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    const controller = new AbortController();
    lspManager.getClient = async () => mockLspClient({ diagnostics: async () => [] });
    try {
      const result = await registry.getTool("lsp_diagnostics").execute("1", { workdir: ".", path: "src/example.ts" }, controller.signal, undefined, { cwd: process.cwd() });
      expect(getText(result)).toBe("No diagnostics found");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("surfaces diagnostics timeouts instead of returning an empty success result", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({ diagnostics: async () => { throw new Error("LSP diagnostics timeout after 60000ms"); } });
    try {
      const result = await registry.getTool("lsp_diagnostics").execute("1", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("LSP diagnostics timeout");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("returns a generic actionable hint for transient Internal error diagnostics failures", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({
      serverId: () => "mock-lsp",
      diagnostics: async () => {
        throw new Error("Internal error");
      },
    });
    try {
      const result = await registry.getTool("lsp_diagnostics").execute("1", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text).toContain("LSP server 'mock-lsp' returned \"Internal error\"");
      expect(text).toContain("configured request timeout");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("surfaces diagnostics client errors", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => {
      throw new Error("no server");
    };
    try {
      const result = await registry.getTool("lsp_diagnostics").execute("1", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("no server");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("surfaces the concise no-server-configured message without extra configuration guidance", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => {
      throw new Error("No LSP server configured for /tmp/demo/README.md.");
    };
    try {
      const result = await registry.getTool("lsp_diagnostics").execute("1", { workdir: ".", path: "/tmp/demo/README.md", severity: "error" }, undefined, undefined, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text).toContain("No LSP server configured for /tmp/demo/README.md.");
      expect(text).not.toContain("Configure it under lsp.servers");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("aborts pending diagnostics client acquisition", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    const controller = new AbortController();
    lspManager.getClient = () => new Promise(() => undefined) as any;
    try {
      const pending = registry.getTool("lsp_diagnostics").execute("1", { workdir: ".", path: "src/example.ts" }, controller.signal, undefined, { cwd: process.cwd() });
      controller.abort();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Operation aborted");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("supports goto_definition with explicit line", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({ definition: async () => ({ uri: "file:///tmp/def.ts", range: { start: { line: 0, character: 1 } } }) });
    try {
      const result = await registry.getTool("lsp_goto_definition").execute("1", { workdir: ".", path: "src/example.ts", line: 2, character: 3 }, undefined, undefined, { cwd: process.cwd() });
      expect(getText(result)).toContain("/tmp/def.ts:1:1");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("rejects non-positive goto_definition lines", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const result = await registry.getTool("lsp_goto_definition").execute("1", { workdir: ".", path: "src/example.ts", line: 0 }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("line must be a positive integer");
  });

  it("defaults goto_definition character to zero", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    let seenCharacter: number | undefined;
    lspManager.getClient = async () => mockLspClient({ definition: async (_path: string, _line: number, character: number) => { seenCharacter = character; return []; } });
    try {
      const result = await registry.getTool("lsp_goto_definition").execute("1", { workdir: ".", path: "src/example.ts", line: 2 }, undefined, undefined, { cwd: process.cwd() });
      expect(getText(result)).toBe("No results found");
      expect(seenCharacter).toBe(0);
    } finally {
      lspManager.getClient = original;
    }
  });

  it("returns a friendly error when the server does not advertise go-to-definition", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({ definition: async () => [] }, ["textDocument/definition"]);
    try {
      const result = await registry.getTool("lsp_goto_definition").execute("1", { workdir: ".", path: "src/example.ts", line: 1, character: 0 }, undefined, undefined, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text).toContain("does not advertise go-to-definition");
      expect(text).toContain("mock-server");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("requires line for goto_definition", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const result = await registry.getTool("lsp_goto_definition").execute("1", { workdir: ".", path: "src/example.ts", character: 0 }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("line is required");
  });

  it("returns no definition results when nothing is found", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({ definition: async () => [] });
    try {
      const result = await registry.getTool("lsp_goto_definition").execute("1", { workdir: ".", path: "src/example.ts", line: 1, character: 0 }, undefined, undefined, { cwd: process.cwd() });
      expect(getText(result)).toBe("No results found");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("normalizes file:// paths before requesting goto_definition", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\n");
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    let seenPath: string | undefined;
    lspManager.getClient = async (filePath: string) => {
      seenPath = filePath;
      return mockLspClient({ definition: async () => [] });
    };
    try {
      const fileUri = pathToFileURL(join(root, "src/example.ts")).href;
      const result = await registry.getTool("lsp_goto_definition").execute("1", { workdir: ".", path: fileUri, line: 1 }, undefined, undefined, { cwd: process.cwd() });
      expect(getText(result)).toBe("No results found");
      expect(seenPath).toBe(join(root, "src/example.ts"));
    } finally {
      lspManager.getClient = original;
    }
  });

  it("returns raw jdt URIs from goto_definition results", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({ definition: async () => ({ uri: "jdt://contents/java.base/java/lang/String.class?123", range: { start: { line: 0, character: 0 } } }) });
    try {
      const result = await registry.getTool("lsp_goto_definition").execute("1", { workdir: ".", path: "src/App.java", line: 1 }, undefined, undefined, { cwd: process.cwd() });
      expect(getText(result)).toBe("jdt://contents/java.base/java/lang/String.class?123");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("formats workspace symbols", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({
      workspaceSymbols: async () => [
        { name: "UserService", kind: 5, location: { uri: "file:///tmp/UserService.java" } },
      ],
    });
    try {
      const result = await registry.getTool("lsp_workspace_symbols").execute("1", { workdir: ".", path: "src/App.java", query: "UserService" }, undefined, undefined, { cwd: process.cwd() });
      expect(getText(result)).toContain("UserService");
      expect(getText(result)).toContain("(Class)");
      expect(getText(result)).toContain("file:///tmp/UserService.java");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("rejects negative workspace symbol limits", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const result = await registry.getTool("lsp_workspace_symbols").execute("1", { workdir: ".", path: "src/App.java", query: "X", limit: -1 }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("limit must be a non-negative integer");
  });

  it("surfaces workspace symbol errors", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({ workspaceSymbols: async () => { throw new Error("symbol failure"); } });
    try {
      const result = await registry.getTool("lsp_workspace_symbols").execute("1", { workdir: ".", path: "src/App.java", query: "UserService" }, undefined, undefined, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("symbol failure");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("returns no symbols when workspaceSymbols is empty", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({ workspaceSymbols: async () => [] });
    try {
      const result = await registry.getTool("lsp_workspace_symbols").execute("1", { workdir: ".", path: "src/App.java", query: "Missing" }, undefined, undefined, { cwd: process.cwd() });
      expect(getText(result)).toBe("No symbols found");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("returns a friendly error when the server does not advertise workspace/symbol", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({ workspaceSymbols: async () => [] }, ["workspace/symbol"]);
    try {
      const result = await registry.getTool("lsp_workspace_symbols").execute("1", { workdir: ".", path: "src/App.java", query: "App" }, undefined, undefined, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text).toContain("does not advertise workspace/symbol support");
      expect(text).toContain("mock-server");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("extracts jdt URI for java decompile", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    let seenTarget: string | undefined;
    lspManager.getClient = async () => mockLspClient({
      classFileContents: async (target: string) => {
        seenTarget = target;
        return "package java.lang;\npublic final class String {}";
      },
      decompileClass: async () => null,
    });
    try {
      const result = await registry.getTool("lsp_java_decompile").execute(
        "1",
        { workdir: ".", target: "String (Class) - jdt://contents/java.base/java/lang/String.class?123", path: "src/App.java" },
        undefined,
        undefined,
        { cwd: process.cwd() },
      );
      expect(seenTarget).toBe("jdt://contents/java.base/java/lang/String.class?123");
      expect(getText(result)).toContain("package java.lang;");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("reports decompile failure when no source is returned", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({
      classFileContents: async () => null,
      decompileClass: async () => null,
    });
    try {
      const result = await registry.getTool("lsp_java_decompile").execute("1", { workdir: ".", path: "src/App.java", target: "build/X.class" }, undefined, undefined, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text.includes("Could not load Java class file contents.") || text.includes("Could not decompile class.")).toBe(true);
    } finally {
      lspManager.getClient = original;
    }
  });

  it("passes file:// targets to decompileClass", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    let seenTarget: string | undefined;
    lspManager.getClient = async () => mockLspClient({
      classFileContents: async () => null,
      decompileClass: async (target: string) => {
        seenTarget = target;
        return "class X {}";
      },
    });
    try {
      const result = await registry.getTool("lsp_java_decompile").execute("1", { workdir: ".", target: "file:///tmp/X.class", path: "src/App.java" }, undefined, undefined, { cwd: process.cwd() });
      expect(seenTarget).toBe("file:///tmp/X.class");
      expect(getText(result)).toContain("class X {}");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("converts local .class paths to file:// before decompiling", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    let seenTarget: string | undefined;
    lspManager.getClient = async () => mockLspClient({
      classFileContents: async () => null,
      decompileClass: async (target: string) => {
        seenTarget = target;
        return "class Y {}";
      },
    });
    try {
      const result = await registry.getTool("lsp_java_decompile").execute("1", { workdir: ".", target: "/tmp/Y.class", path: "src/App.java" }, undefined, undefined, { cwd: process.cwd() });
      expect(seenTarget?.startsWith("file://")).toBe(true);
      expect(getText(result)).toContain("class Y {}");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("resolves relative .class targets against the tool cwd", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    let seenTarget: string | undefined;
    lspManager.getClient = async () => mockLspClient({
      classFileContents: async () => null,
      decompileClass: async (target: string) => {
        seenTarget = target;
        return "class Z {}";
      },
    });
    try {
      const result = await registry.getTool("lsp_java_decompile").execute("1", { workdir: ".", target: "build/Z.class", path: "src/App.java" }, undefined, undefined, { cwd: root });
      expect(seenTarget).toBe(pathToFileURL(join(root, "build/Z.class")).href);
      expect(getText(result)).toContain("class Z {}");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("returns a friendly error when decompile is requested on a non-jdtls server", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockLspClient({ classFileContents: async () => null, decompileClass: async () => null }, ["java/classFileContents"]);
    try {
      const result = await registry.getTool("lsp_java_decompile").execute("1", { workdir: ".", target: "jdt://x", path: "src/App.java" }, undefined, undefined, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      const text = getText(result);
      expect(text).toContain("lsp_java_decompile is only supported by jdtls");
      expect(text).toContain("mock-server");
    } finally {
      lspManager.getClient = original;
    }
  });

  it("surfaces lsp_java_decompile client errors", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => {
      throw new Error("jdtls missing");
    };
    try {
      const result = await registry.getTool("lsp_java_decompile").execute("1", { workdir: ".", target: "jdt://x", path: "src/App.java" }, undefined, undefined, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("jdtls missing");
    } finally {
      lspManager.getClient = original;
    }
  });
});
