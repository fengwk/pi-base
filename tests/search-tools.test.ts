import { describe, expect, it } from "vitest";
import piBaseExtension, { registerFindTool } from "../index.js";
import { registerGrepTool } from "../src/grep.js";
import { computeLineHash } from "../src/hashline.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("grep", () => {
  it("returns anchored matches from builtin output", async () => {
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
    const result = await registry.getTool("grep").execute("1", { pattern: "x", path: ".", timeoutSeconds: 0.01 }, undefined, undefined, { cwd: process.cwd() });
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
    const pending = registry.getTool("grep").execute("1", { pattern: "x", path: ".", timeoutSeconds: 30 }, controller.signal, undefined, { cwd: process.cwd() });
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

  it("truncates huge single-line matches but keeps hashes from raw content", async () => {
    const root = await createTempWorkspace();
    const longLine = `prefix ${"x".repeat(2500)}`;
    await writeWorkspaceFile(root, "src/huge.txt", `${longLine}\n`);
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any, {
      createBuiltInGrepTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "huge.txt:1: prefix" }] }) }),
    });
    const result = await registry.getTool("grep").execute("1", { pattern: "prefix", path: "src" }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain(`1:${computeLineHash(1, longLine)}|`);
    expect(text).toContain("line truncated to 2000 chars");
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

  it("passes raw-split lines to onFileAnchored (3 lines for alpha\\nbeta\\n, including the empty after the trailing \\n)", async () => {
    const root = await createTempWorkspace();
    // `alpha\nbeta\n` is the file as it actually is: 3 lines,
    // because the trailing newline creates an implicit empty line
    // at the end of the split. `grep` shows the file as-is.
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    const anchored: Array<{ path: string; lines: string[] | undefined }> = [];
    registerGrepTool(registry.pi as any, {
      onFileAnchored: (absolutePath, lines) => anchored.push({ path: absolutePath, lines }),
      createBuiltInGrepTool: () => ({
        execute: async () => ({ content: [{ type: "text", text: "example.ts:2: beta" }] }),
      }),
    });
    const result = await registry.getTool("grep").execute("1", { pattern: "beta", path: "src" }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    expect(anchored).toHaveLength(1);
    expect(anchored[0].lines).toEqual(["alpha", "beta", ""]);
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
});
