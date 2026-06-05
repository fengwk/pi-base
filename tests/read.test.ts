import { describe, expect, it } from "vitest";
import { computeLineHash } from "../src/hashline.js";
import { registerReadTool } from "../src/read.js";
import { LspDiscoveryResolver } from "../src/lsp/discovery.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("read tool", () => {
  it("reads text files with hashlines and offset/limit", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\ntwo\nthree\nfour\n");
    const registry = createToolRegistry();
    const resolver = new LspDiscoveryResolver({
      servers: {
        typescript: {
          command: ["typescript-language-server", "--stdio"],
          extensions: [".ts", ".tsx"],
        },
      },
    });
    registerReadTool(registry.pi as any, { createResolver: () => resolver });
    const result = await registry.getTool("read").execute("1", { path: "src/example.ts", offset: 2, limit: 2 }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain("path: src/example.ts");
    expect(text).toContain("offset: 2");
    expect(text).toContain("lsp: file type supported, but server not installed (typescript)");
    expect(text).toContain("2#");
    expect(text).toContain("two");
    expect(text).toContain("3#");
    expect(text).toContain("three");
  });

  it("uses the target file directory when building the LSP resolver for absolute paths outside cwd", async () => {
    const rootA = await createTempWorkspace();
    const rootB = await createTempWorkspace();
    await writeWorkspaceFile(rootB, "src/example.ts", "one\n");
    const registry = createToolRegistry();
    let seenBaseDir: string | undefined;
    registerReadTool(registry.pi as any, {
      createResolver: (baseDir: string) => {
        seenBaseDir = baseDir;
        return { supportsLsp: () => ({ supported: false }) } as any;
      },
    });
    const absoluteFile = join(rootB, "src", "example.ts");
    const result = await registry.getTool("read").execute("1", { path: absoluteFile }, undefined, undefined, { cwd: rootA });
    expect(result.isError).not.toBe(true);
    expect(seenBaseDir).toBe(join(rootB, "src"));
  });

  it("reads directories", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src/utils"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), "a\n", "utf8");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { path: "src" }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain("kind: directory");
    expect(text).toContain("a.ts");
    expect(text).toContain("utils/");
  });

  it("preserves non-ASCII spaces inside file names", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/hello　world.ts", "alpha\n");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { path: "src/hello　world.ts" }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("path: src/hello　world.ts");
    expect(getText(result)).toContain("|alpha");
  });

  it("honors cancellation before filesystem work starts", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\n");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const controller = new AbortController();
    controller.abort();
    const result = await registry.getTool("read").execute("1", { path: "src/example.ts" }, controller.signal, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Operation aborted");
  });

  it("formats read calls in opencode style", async () => {
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const component = registry.getTool("read").renderCall({ path: "/home/fengwk/proj/pi-base/src/edit.ts", offset: 150, limit: 110 }, {} as any, { lastComponent: undefined }) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("Read ~/proj/pi-base/src/edit.ts [offset=150, limit=110]");
  });

  it("truncates very long lines", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "dist/bundle.txt", `${"x".repeat(2500)}\n`);
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { path: "dist/bundle.txt", limit: 1 }, undefined, undefined, { cwd: root });
    expect(getText(result)).toContain("line truncated to 2000 chars");
    expect(getText(result)).toContain("lsp: unsupported");
  });

  it("hashes truncated lines from raw content", async () => {
    const root = await createTempWorkspace();
    const longLine = "x".repeat(2500);
    await writeWorkspaceFile(root, "dist/bundle.txt", longLine);
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { path: "dist/bundle.txt", limit: 1 }, undefined, undefined, { cwd: root });
    const expectedHash = computeLineHash(1, longLine);
    expect(getText(result)).toContain(`1#${expectedHash}|`);
    expect(getText(result)).toContain("line truncated to 2000 chars");
  });

  it("right-aligns hashlines for multi-digit line numbers", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.txt", Array.from({ length: 11 }, (_, index) => `line-${index + 1}`).join("\n"));
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { path: "src/example.txt", offset: 9, limit: 3 }, undefined, undefined, { cwd: root });
    const lines = getText(result).split("\n");
    expect(lines.find((line) => line.includes("|line-9"))?.startsWith(" 9#")).toBe(true);
    expect(lines.find((line) => line.includes("|line-10"))?.startsWith("10#")).toBe(true);
  });

  it("delegates supported images to the built-in read tool", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "image.png", "fake");
    const registry = createToolRegistry();
    let seenPath: string | undefined;
    registerReadTool(registry.pi as any, {
      createBuiltInReadTool: () => ({
        execute: async (_toolCallId: string, params: any) => {
          seenPath = params.path;
          return { content: [{ type: "text", text: "image delegated" }] };
        },
      }),
    });
    const result = await registry.getTool("read").execute("1", { path: "@image.png" }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain("path: image.png");
    expect(text).toContain("mediaType: image");
    expect(text).toContain("image delegated");
    expect(seenPath).toBe("image.png");
  });

  it("marks anchors only for text file reads", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src/dir"), { recursive: true });
    await writeWorkspaceFile(root, "src/file.ts", "alpha\n");
    await writeWorkspaceFile(root, "image.png", "fake");
    const anchored: Array<{ path: string; lines?: string[] }> = [];
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any, {
      onSuccessfulRead: (absolutePath, lines) => anchored.push({ path: absolutePath, lines }),
      createBuiltInReadTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "image delegated" }] }) }),
    });

    await registry.getTool("read").execute("1", { path: "src/dir" }, undefined, undefined, { cwd: root });
    await registry.getTool("read").execute("2", { path: "image.png" }, undefined, undefined, { cwd: root });
    await registry.getTool("read").execute("3", { path: "src/file.ts" }, undefined, undefined, { cwd: root });

    expect(anchored).toHaveLength(1);
    expect(anchored[0]?.path.endsWith("src/file.ts")).toBe(true);
    expect(anchored[0]?.lines?.[0]).toBe("alpha");
  });

  it("rejects binary non-image files", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "data.bin"), Buffer.from([0, 1, 2, 3]));
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { path: "data.bin" }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("appears to be a binary file");
  });

  it("reports invalid limits", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\n");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { path: "src/example.ts", limit: 5000 }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("limit must be <= 2000");
  });

  it("reports totalLines matching the file's raw split(\"\\n\") length (including the implicit empty from a trailing newline)", async () => {
    // `read` is a fact-display tool: it shows the file as it is.
    // `one\ntwo\nthree\n` splits into 4 elements: "one", "two",
    // "three", and the implicit empty produced by the trailing
    // newline. So totalLines is 4 — the same number `write` and
    // `edit` use to anchor lines. The agent and the human see the
    // same fact.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\ntwo\nthree\n");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain("totalLines: 4");
    expect(text).toMatch(/\b3#[0-9a-f]{4}\|three/);
    expect(text).toMatch(/\b4#[0-9a-f]{4}\|$/);
  });

  it("reports totalLines: 1 for an empty file (one empty line)", async () => {
    // `""` splits into `[""]` — a single empty element. We report
    // the raw fact rather than hiding it.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/empty.ts", "");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { path: "src/empty.ts" }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("totalLines: 1");
  });

  it("keeps a final unterminated line", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\ntwo");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain("totalLines: 2");
    expect(text).toMatch(/\b2#[0-9a-f]{4}\|two/);
  });
});
