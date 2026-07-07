import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "../src/read.js";
import { LspDiscoveryResolver } from "../src/lsp/discovery.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

describe("read tool", () => {
  it("reads text files with numbered lines and offset/limit", async () => {
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
    expect(text).not.toMatch(/\[src\/example\.ts#/);
    expect(text).toContain("path: src/example.ts");
    expect(text).toContain("ends_with_newline: yes");
    expect(text).toContain("2|two");
    expect(text).toContain("3|three");
    expect(text).toContain("3|three\n\n[Showing lines 2-3 of 4. Re-run read with offset=4 to continue.]");
    expect(text).toContain("lsp: file type supported, but server not installed (typescript)");
    expect(text).not.toContain("kind: file");
    expect(text).not.toContain("encoding:");
  });

  it("does not emit TAG header", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\ntwo\n");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).not.toMatch(/^\[.*#[0-9A-F]{4}\]$/m);
    expect(text).toContain("ends_with_newline: yes");
    expect(text).toContain("1|one");
    expect(text).toContain("2|two");
  });

  it("reports factual metadata while keeping a normalized body view", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src", "mixed.txt");
    await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\ntwo\rthree", "utf8")]));
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "src/mixed.txt" }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain("ends_with_newline: no");
    expect(text).toContain("1|one");
    expect(text).toContain("2|two");
    expect(text).toContain("3|three");
  });

  it("detects utf-16le text files and preserves a normal text view", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src", "utf16.txt");
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("alpha\r\nbeta\r\n", "utf16le")]));
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "src/utf16.txt" }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain("ends_with_newline: yes");
    expect(text).toContain("1|alpha");
    expect(text).toContain("2|beta");
  });

  it("detects legacy windows-1252 text files", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src", "legacy.txt");
    await writeFile(file, Buffer.from("café\nolé\n", "latin1"));
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "src/legacy.txt" }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain("ends_with_newline: yes");
    expect(text).toContain("1|café");
    expect(text).toContain("2|olé");
  });

  it("right-aligns read line numbers to the file width", async () => {
    const root = await createTempWorkspace();
    const lines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n");
    await writeWorkspaceFile(root, "src/padded.txt", `${lines}\n`);
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "src/padded.txt", offset: 9, limit: 3 }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain(" 9|line-9");
    expect(text).toContain("10|line-10");
    expect(text).toContain("11|line-11");
  });

  it("marks read results whose displayed lines were truncated", async () => {
    // Intent: the global output guard must know that read only has a display
    // preview, not the full source line, so it should not claim a full output file.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/long.txt", `${"x".repeat(2100)}\n`);
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "src/long.txt" }, undefined, undefined, { cwd: root });
    expect(result.details?.upstreamTextTruncated).toBe(true);
    expect(getText(result)).toContain("line truncated to 2000 chars");
  });

  it("waits for in-flight file mutations before reading file contents", async () => {
    // Intent: read must cooperate with edit/write's per-file queue so it never
    // observes a same-process write in the middle of its critical section.
    const root = await createTempWorkspace();
    const absolutePath = await writeWorkspaceFile(root, "src/queued.txt", "stable\n");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);

    let releaseMutation!: () => void;
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolve) => { mutationStarted = resolve; });
    const blocker = withFileMutationQueue(absolutePath, async () => {
      mutationStarted();
      await new Promise<void>((resolve) => { releaseMutation = resolve; });
    });
    await started;

    let settled = false;
    const pending = registry.getTool("read")
      .execute("1", { workdir: ".", path: "src/queued.txt" }, undefined, undefined, { cwd: root })
      .then((result: any) => {
        settled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    releaseMutation();
    await blocker;
    const result = await pending;
    expect(getText(result)).toContain("1|stable");
  });

  it("treats an empty file as having zero body lines", async () => {
    // Intent: empty files must not invent a synthetic numbered content line, so line counts
    // and follow-up offsets remain accurate for the agent.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/empty.txt", "");
    const seen: Array<string[] | undefined> = [];
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any, {
      onSuccessfulRead: (_absolutePath, lines) => seen.push(lines),
    });
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "src/empty.txt" }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain("ends_with_newline: no");
    expect(text).not.toContain("\n1|");
    expect(seen).toEqual([[]]);
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
    registerReadTool(registry.pi as any);
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "src/hello　world.ts" }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("1|alpha");
  });

  it("truncates very long lines", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "dist/bundle.txt", `${"x".repeat(2500)}\n`);
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
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
    // Intent: image delegation should only happen when the active model
    // explicitly advertises image input support.
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: "@image.png" }, undefined, undefined, { cwd: root, model: { input: ["text", "image"] } });
    const text = getText(result);
    expect(text).toContain("path: image.png");
    expect(text).toContain("mediaType: image");
    expect(text).toContain("image delegated");
    expect(seenPath).toBe("image.png");
  });

  it("calls onSuccessfulRead only for text file reads", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src/dir"), { recursive: true });
    await writeWorkspaceFile(root, "src/file.ts", "alpha\n");
    await writeWorkspaceFile(root, "image.png", "fake");
    const seen: Array<{ path: string; lines?: string[] }> = [];
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any, {
      onSuccessfulRead: (absolutePath, lines) => seen.push({ path: absolutePath, lines }),
      createBuiltInReadTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "image delegated" }] }) }),
    });

    await registry.getTool("read").execute("1", { workdir: ".", path: "src/dir" }, undefined, undefined, { cwd: root });
    await registry.getTool("read").execute("2", { workdir: ".", path: "image.png" }, undefined, undefined, { cwd: root });
    await registry.getTool("read").execute("3", { workdir: ".", path: "src/file.ts" }, undefined, undefined, { cwd: root });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.path.endsWith("src/file.ts")).toBe(true);
    expect(seen[0]?.lines).toEqual(["alpha"]);
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
