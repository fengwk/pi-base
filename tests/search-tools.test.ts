import { describe, expect, it } from "vitest";
import piBaseExtension, { registerFindTool } from "../index.js";
import { registerGrepTool } from "../src/grep.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("grep", () => {
  it("returns matching lines from builtin output without adding anchors", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any, {
      createBuiltInGrepTool: () => ({
        execute: async () => ({ content: [{ type: "text", text: "example.ts:2: beta" }] }),
      }),
    });
    const result = await registry.getTool("grep").execute("1", { pattern: "beta", path: "src" }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain("example.ts");
    expect(text).toContain("2:");
    expect(text).toContain("beta");
    expect(text).not.toMatch(/\d+#[0-9a-f]{4}\|/);
  });

  it("reports timeout guidance", async () => {
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any, {
      createBuiltInGrepTool: () => ({
        execute: async (_id: string, _params: any, signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      }),
    });
    const result = await registry.getTool("grep").execute("1", { pattern: "x", path: ".", timeout_seconds: 0.01 }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Search timed out");
  });

  it("does not misreport parent cancellation as a timeout", async () => {
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any, {
      createBuiltInGrepTool: () => ({
        execute: async (_id: string, _params: any, signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      }),
    });
    const controller = new AbortController();
    const pending = registry.getTool("grep").execute("1", { pattern: "x", path: ".", timeout_seconds: 30 }, controller.signal, undefined, { cwd: process.cwd() });
    controller.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(getText(result)).not.toContain("Search timed out");
    expect(getText(result)).toContain("aborted");
  });

  it("reports binary file guidance", async () => {
    const root = await createTempWorkspace();
    let builtInCalled = false;
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any, {
      createBuiltInGrepTool: () => ({
        execute: async () => {
          builtInCalled = true;
          return { content: [{ type: "text", text: "binary.bin:1: ignored" }] };
        },
      }),
    });
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    const result = await registry.getTool("grep").execute("1", { pattern: "x", path: "binary.bin" }, undefined, undefined, { cwd: root });
    expect(builtInCalled).toBe(false);
    expect(getText(result)).toContain("binary file");
    expect(getText(result)).toContain("grep only supports searching text files");
  });
  it("falls through to upstream grep when the search path is missing", async () => {
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any, {
      createBuiltInGrepTool: () => ({ execute: async () => ({ content: [{ type: "text" as const, text: "missing-path fallback" }] }) }),
    });

    const result = await registry.getTool("grep").execute("1", { pattern: "x", path: "missing.txt", timeout_seconds: 5 }, undefined, undefined, { cwd: process.cwd() });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("missing-path fallback");
  });

  it("preserves no-match output", async () => {
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any, {
      createBuiltInGrepTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "No matches found" }] }) }),
    });
    const result = await registry.getTool("grep").execute("1", { pattern: "x", path: "." }, undefined, undefined, { cwd: process.cwd() });
    expect(getText(result)).toContain("No matches found");
  });

  it("returns builtin result when no text block is present", async () => {
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any, {
      createBuiltInGrepTool: () => ({ execute: async () => ({ content: [{ type: "image", data: "x", mimeType: "image/png" }] }) }),
    });
    const result = await registry.getTool("grep").execute("1", { pattern: "x", path: "." }, undefined, undefined, { cwd: process.cwd() });
    expect(result.content[0].type).toBe("image");
  });

  it("preserves passthrough lines", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any, {
      createBuiltInGrepTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "[summary]\nexample.ts:2: beta" }] }) }),
    });
    const result = await registry.getTool("grep").execute("1", { pattern: "beta", path: "src" }, undefined, undefined, { cwd: root });
    expect(getText(result)).toContain("[summary]");
  });

  it("preserves builtin truncation text and details", async () => {
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any, {
      createBuiltInGrepTool: () => ({
        execute: async () => ({
          content: [{ type: "text", text: "huge.txt:1: prefix...\n\n[Some lines truncated to 500 chars. Use read tool to see full lines]" }],
          details: { linesTruncated: true },
        }),
      }),
    });
    const result = await registry.getTool("grep").execute("1", { pattern: "prefix", path: "src" }, undefined, undefined, { cwd: process.cwd() });
    const text = getText(result);
    expect(text).toContain("huge.txt:1: prefix");
    expect(text).toContain("Some lines truncated to 500 chars");
    expect((result as any).details?.linesTruncated).toBe(true);
  });

  it("surfaces non-timeout builtin errors", async () => {
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any, {
      createBuiltInGrepTool: () => ({ execute: async () => { throw new Error("grep failed"); } }),
    });
    const result = await registry.getTool("grep").execute("1", { pattern: "x", path: "." }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("grep failed");
  });

  it("validates required path", async () => {
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any, {
      createBuiltInGrepTool: () => ({ execute: async () => ({ content: [] }) }),
    });
    const result = await registry.getTool("grep").execute("1", { pattern: "x" }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("path is required");
  });

  it("passes include to builtin grep as glob", async () => {
    const registry = createToolRegistry();
    let seenParams: any;
    registerGrepTool(registry.pi as any, {
      createBuiltInGrepTool: () => ({
        execute: async (_id: string, params: any) => {
          seenParams = params;
          return { content: [{ type: "text", text: "example.ts:2: beta" }] };
        },
      }),
    });
    const result = await registry.getTool("grep").execute("1", { pattern: "beta", path: "src", include: "**/*.ts" }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).not.toBe(true);
    expect(seenParams.glob).toBe("**/*.ts");
  });
});

describe("find (delegated to built-in pi-coding-agent)", () => {
  it("is registered when piBaseExtension is loaded", () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    expect(registry.getTool("find")).toBeTruthy();
  });

  it("uses the current execution cwd", async () => {
    const rootA = await createTempWorkspace();
    const rootB = await createTempWorkspace();
    const registry = createToolRegistry();
    registerFindTool(registry.pi as any, (cwd) => ({
      name: "find",
      label: "Find",
      description: "test find",
      parameters: {},
      execute: async () => ({ content: [{ type: "text" as const, text: cwd }] }),
    }));

    // `path` is required; pass it explicitly. The wrapper still resolves
    // it against the per-execution `ctx.cwd`, which is the contract under test.
    const resultA = await registry.getTool("find").execute("1", { pattern: "*", path: "." }, undefined, undefined, { cwd: rootA });
    const resultB = await registry.getTool("find").execute("2", { pattern: "*", path: "." }, undefined, undefined, { cwd: rootB });
    expect(getText(resultA)).toBe(rootA);
    expect(getText(resultB)).toBe(rootB);
  });
  it("applies timeout_seconds without passing it to the built-in find", async () => {
    const registry = createToolRegistry();
    let seenParams: any;
    registerFindTool(registry.pi as any, () => ({
      name: "find",
      label: "Find",
      description: "test find",
      parameters: {},
      execute: async (_id: string, params: any, signal?: AbortSignal) => {
        seenParams = params;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    }));

    const result = await registry.getTool("find").execute("1", { pattern: "*", path: ".", timeout_seconds: 0.01 }, undefined, undefined, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("find timed out");
    expect(seenParams).toEqual({ pattern: "*", path: "." });
  });
  it("rethrows non-timeout find errors", async () => {
    const registry = createToolRegistry();
    registerFindTool(registry.pi as any, () => ({
      name: "find",
      label: "Find",
      description: "test find",
      parameters: {},
      execute: async () => {
        throw new Error("find boom");
      },
    }));

    await expect(registry.getTool("find").execute("1", { pattern: "*", path: ".", timeout_seconds: 30 }, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow("find boom");
  });

  it("delegates find renderResult when collapsed result lines are not configured", () => {
    const registry = createToolRegistry();
    registerFindTool(
      registry.pi as any,
      () => ({
        name: "find",
        label: "Find",
        description: "test find",
        parameters: {},
        execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        renderResult: () => "delegated-render",
      }),
      { getCollapsedResultLines: () => undefined },
    );

    expect(registry.getTool("find").renderResult({ content: [{ type: "text", text: "ok" }] }, {}, {}, { cwd: process.cwd() })).toBe("delegated-render");
  });
});
