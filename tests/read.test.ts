import { describe, expect, it } from "vitest";
import { mkdir, open, writeFile } from "node:fs/promises";
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

  it("keeps a successful read result when its observer throws", async () => {
    // Intent: read observation is auxiliary bookkeeping; once file content is available, observer
    // failure must not replace it with a misleading tool error.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/observed.txt", "alpha\n");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any, {
      onSuccessfulRead: () => {
        throw new Error("observer failed");
      },
    });

    const result = await registry.getTool("read").execute(
      "read-observer",
      { path: "src/observed.txt" },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("1|alpha");
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
    expect(getText(result)).toContain("lsp: unsupported");
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

  it.each(["image.png", "image.bmp"])("delegates supported image %s to the built-in read tool", async (imagePath) => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, imagePath, "fake");
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
    const result = await registry.getTool("read").execute("1", { workdir: ".", path: `@${imagePath}` }, undefined, undefined, { cwd: root, model: { input: ["text", "image"] } });
    const text = getText(result);
    expect(text).toContain(`path: ${imagePath}`);
    expect(text).toContain("mediaType: image");
    expect(text).toContain("image delegated");
    expect(seenPath).toBe(imagePath);
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

  it("validates offset and limit before touching the requested filesystem path", async () => {
    // Intent: using a missing path makes I/O observable: argument errors must win over ENOENT,
    // proving malformed windows are rejected before stat or a potentially huge readFile call.
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    const invalidOffset = await registry.getTool("read").execute("1", { workdir: ".", path: "missing.txt", offset: 0 }, undefined, undefined, { cwd: root });
    const invalidLimit = await registry.getTool("read").execute("2", { workdir: ".", path: "missing.txt", limit: 5000 }, undefined, undefined, { cwd: root });

    expect(invalidOffset.isError).toBe(true);
    expect(getText(invalidOffset)).toContain("offset must be a positive integer");
    expect(getText(invalidOffset)).not.toContain("ENOENT");
    expect(invalidLimit.isError).toBe(true);
    expect(getText(invalidLimit)).toContain("limit must be <= 2000");
    expect(getText(invalidLimit)).not.toContain("ENOENT");
  });

  it("rejects a sparse text candidate above 64 MiB before entering the full-read queue", async () => {
    // Intent: the queue is held for the target path; returning the size error while it remains
    // held proves readFile/decode never allocate the sparse file's full logical size.
    const root = await createTempWorkspace();
    const file = join(root, "huge.txt");
    const handle = await open(file, "w");
    await handle.truncate(64 * 1024 * 1024 + 1);
    await handle.close();

    let releaseMutation!: () => void;
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolve) => { mutationStarted = resolve; });
    const blocker = withFileMutationQueue(file, async () => {
      mutationStarted();
      await new Promise<void>((resolve) => { releaseMutation = resolve; });
    });
    await started;

    const registry = createToolRegistry();
    registerReadTool(registry.pi as any);
    try {
      const result = await Promise.race([
        registry.getTool("read").execute("huge", { path: "huge.txt", offset: 1, limit: 1 }, undefined, undefined, { cwd: root }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("read entered the full-file mutation queue")), 1_000)),
      ]);
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("larger than the 64 MiB read safety limit");
      expect(getText(result)).toContain("Use grep");
    } finally {
      releaseMutation();
      await blocker;
    }
  });
});
