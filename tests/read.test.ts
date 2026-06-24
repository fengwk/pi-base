import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerReadTool } from "../src/read.js";
import { InMemorySnapshotStore } from "../src/hashline.js";
import { LspDiscoveryResolver } from "../src/lsp/discovery.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

describe("read tool", () => {
  it("reads text files in hashline mode with offset/limit", async () => {
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
    registerReadTool(registry.pi as any, {
      snapshots: new InMemorySnapshotStore(),
      createResolver: () => resolver,
    });

    const result = await registry.getTool("read").execute(
      "1",
      { workdir: ".", path: "src/example.ts", offset: 2, limit: 2 },
      undefined,
      undefined,
      { cwd: root },
    );
    const text = getText(result);
    expect(text).toMatch(/^\[src\/example\.ts#[0-9A-F]{4}\]$/m);
    expect(text).toContain("2:two");
    expect(text).toContain("3:three");
    expect(text).toContain("[Showing lines 2-3 of 4. Re-run read with offset=4 to continue.]");
    expect(text).toContain("[lsp: file type supported, but server not installed (typescript)]");
  });

  it("records only the displayed lines for partial reads", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\ntwo\nthree\nfour\n");
    const registry = createToolRegistry();
    const snapshots = new InMemorySnapshotStore();
    let seenMeta: { tag?: string; displayedLines?: number[] } | undefined;
    registerReadTool(registry.pi as any, {
      snapshots,
      onSuccessfulRead: (_absolutePath, _lines, meta) => {
        seenMeta = meta;
      },
    });

    const result = await registry.getTool("read").execute(
      "1",
      { workdir: ".", path: "src/example.ts", offset: 2, limit: 2 },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    expect(seenMeta?.displayedLines).toEqual([2, 3]);
    const snapshot = snapshots.head(join(root, "src", "example.ts"));
    expect(snapshot?.seenLines ? [...snapshot.seenLines].sort((a, b) => a - b) : []).toEqual([2, 3]);
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
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: absoluteFile }, undefined, undefined, { cwd: rootA });
    expect(result.isError).not.toBe(true);
    expect(seenBaseDir).toBe(join(rootB, "src"));
  });

  it("reads directories", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src/utils"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), "a\n", "utf8");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "src" }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain("kind: directory");
    expect(text).toContain("a.ts");
    expect(text).toContain("utils/");
  });

  it("preserves non-ASCII spaces inside file names", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/hello　world.ts", "alpha\n");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any, { snapshots: new InMemorySnapshotStore() });
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "src/hello　world.ts" }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    expect(getText(result)).toMatch(/^\[src\/hello　world\.ts#[0-9A-F]{4}\]$/m);
    expect(getText(result)).toContain("1:alpha");
  });

  it("truncates very long lines", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "dist/bundle.txt", `${"x".repeat(2500)}\n`);
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any, { snapshots: new InMemorySnapshotStore() });
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "dist/bundle.txt", limit: 1 }, undefined, undefined, { cwd: root });
    expect(getText(result)).toContain(`line truncated to 2000 chars`);
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
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "@image.png" }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain("path: image.png");
    expect(text).toContain("mediaType: image");
    expect(text).toContain("image delegated");
    expect(seenPath).toBe("image.png");
  });

  it("marks snapshots only for text file reads", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src/dir"), { recursive: true });
    await writeWorkspaceFile(root, "src/file.ts", "alpha\n");
    await writeWorkspaceFile(root, "image.png", "fake");
    const seen: Array<{ path: string; lines?: string[]; displayedLines?: number[] }> = [];
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any, {
      onSuccessfulRead: (absolutePath, lines, meta) => seen.push({ path: absolutePath, lines, displayedLines: meta?.displayedLines }),
      createBuiltInReadTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "image delegated" }] }) }),
      snapshots: new InMemorySnapshotStore(),
    });

    await registry.getTool("read").execute("1", { workdir: ".", path: "src/dir" }, undefined, undefined, { cwd: root });
    await registry.getTool("read").execute("2", { workdir: ".", path: "image.png" }, undefined, undefined, { cwd: root });
    await registry.getTool("read").execute("3", { workdir: ".", path: "src/file.ts" }, undefined, undefined, { cwd: root });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.path.endsWith("src/file.ts")).toBe(true);
    expect(seen[0]?.lines).toEqual(["alpha"]);
    expect(seen[0]?.displayedLines).toEqual([1]);
  });

  it("rejects binary non-image files", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "data.bin"), Buffer.from([0, 1, 2, 3]));
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "data.bin" }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("appears to be a binary file");
  });

  it("reports invalid limits", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\n");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "src/example.ts", limit: 5000 }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("limit must be <= 2000");
  });
});
