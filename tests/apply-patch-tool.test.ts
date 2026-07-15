import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piBaseExtension from "../index.js";
import { registerApplyPatchTool } from "../src/apply-patch-tool.js";
import { lspManager } from "../src/lsp/client.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

function patch(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

function render(component: any): string {
  return component.render(200).join("\n");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let previousGlobalSettingsPath: string | undefined;

beforeEach(async () => {
  previousGlobalSettingsPath = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  const configRoot = await createTempWorkspace();
  const globalPath = join(configRoot, "pi-base.json");
  await writeFile(globalPath, "{}", "utf8");
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalPath;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousGlobalSettingsPath === undefined) delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  else process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
});

describe("apply_patch tool", () => {
  it("publishes the exact schema and rejects invalid arguments", async () => {
    // Intent: schema guidance and runtime validation must agree even when a caller bypasses prepareArguments.
    const registry = createToolRegistry();
    registerApplyPatchTool(registry.pi as any);
    const tool = registry.getTool("apply_patch");

    expect(tool.parameters.required).toEqual(["patchText"]);
    expect(tool.parameters.properties).toEqual({
      patchText: expect.objectContaining({ type: "string" }),
      workdir: expect.objectContaining({ type: "string" }),
    });
    expect(() => tool.prepareArguments({})).toThrow();
    expect(tool.prepareArguments({ patchText: patch("*** Add File: valid.txt", "+ok") })).toMatchObject({ patchText: expect.any(String) });
    expect(tool.prepareArguments({ patchText: patch("*** Add File: valid.txt", "+ok"), workdir: "pkg" }))
      .toMatchObject({ patchText: expect.any(String), workdir: "pkg" });

    const absent = await tool.execute("absent", undefined, undefined, undefined, { cwd: process.cwd() });
    expect(absent.isError).toBe(true);
    const missing = await tool.execute("missing", {}, undefined, undefined, { cwd: process.cwd() });
    expect(missing.isError).toBe(true);
    expect(getText(missing)).toContain("patchText is required and must be a string");
    expect(missing.details.__piBase.isError).toBe(true);

    const badWorkdir = await tool.execute("workdir", { patchText: patch("*** Add File: a", "+x"), workdir: 1 }, undefined, undefined, { cwd: process.cwd() });
    expect(badWorkdir.isError).toBe(true);
    expect(getText(badWorkdir)).toContain("workdir must be a string");
    const emptyWorkdir = await tool.execute("empty-workdir", { patchText: patch("*** Add File: a", "+x"), workdir: "" }, undefined, undefined, { cwd: process.cwd() });
    expect(emptyWorkdir.isError).toBe(true);
    expect(getText(emptyWorkdir)).toContain("workdir must be a non-empty string");
    const malformed = await tool.execute("malformed", { patchText: "not a patch" }, undefined, undefined, { cwd: process.cwd() });
    expect(malformed.isError).toBe(true);
    expect(getText(malformed)).toContain("Patch must start with");

    const controller = new AbortController();
    controller.abort();
    const aborted = await tool.execute("aborted", { patchText: "not a patch\n".repeat(10_000) }, controller.signal, undefined, { cwd: process.cwd() });
    expect(aborted.isError).toBe(true);
    expect(getText(aborted)).toContain("Operation aborted");
    expect(getText(aborted)).not.toContain("Patch must start with");
  });

  it("renders default and explicit workdirs, every target kind, and malformed fallback", () => {
    // Intent: completed calls preserve the complete review payload, including
    // malformed input whose execution will fail validation.
    const registry = createToolRegistry();
    registerApplyPatchTool(registry.pi as any);
    const tool = registry.getTool("apply_patch");
    const valid = patch(
      "*** Add File: add.txt",
      "+added",
      "*** Update File: update.txt",
      "@@",
      " unchanged",
      "-old",
      "+new",
      "*** Delete File: delete.txt",
    );

    const defaultWorkdir = render(tool.renderCall({ patchText: valid }, {} as any, { cwd: "/repo", argsComplete: true }));
    expect(defaultWorkdir).toContain("apply_patch");
    expect(defaultWorkdir).not.toContain(" in /repo");
    expect(defaultWorkdir).toContain("A add.txt");
    expect(defaultWorkdir).toContain("+added");
    expect(defaultWorkdir).toContain("M update.txt");
    expect(defaultWorkdir).toContain("-old");
    expect(defaultWorkdir).toContain("+new");
    expect(defaultWorkdir).toContain("D delete.txt");
    expect(defaultWorkdir).toContain("(delete file)");

    const explicitWorkdir = render(tool.renderCall({ patchText: valid, workdir: "pkg" }, {} as any, { cwd: "/repo", argsComplete: true }));
    expect(explicitWorkdir).toContain("apply_patch in pkg");
    const move = render(tool.renderCall({
      patchText: patch("*** Update File: old.txt", "*** Move to: new.txt", "@@", "-old", "+new"),
    }, {} as any, { cwd: "/repo", argsComplete: true }));
    expect(move).toContain("Targets: M old.txt -> new.txt");

    const missingPatch = render(tool.renderCall({}, {} as any, { cwd: "/repo", argsComplete: false }));
    expect(missingPatch.trim()).toBe("apply_patch");
    const malformed = render(tool.renderCall({ patchText: "*** Begin Patch\nmalformed" }, {} as any, { cwd: "/repo", argsComplete: true }));
    expect(malformed).toContain("*** Begin Patch");
    expect(malformed).toContain("malformed");
    const malformedLarge = render(tool.renderCall({
      patchText: ["*** Begin Patch", ...Array.from({ length: 60 }, (_, index) => `malformed-${index + 1}`)].join("\n"),
    }, {} as any, { cwd: "/repo", argsComplete: true }));
    expect(malformedLarge).toContain("malformed-60");
    expect(malformedLarge).not.toContain("more patch lines");
  });

  it("shows the complete patch preview once arguments are complete", () => {
    // Intent: permission and completed history rely on the call preview as the
    // authoritative human-review surface; only argument streaming is height-bounded.
    const registry = createToolRegistry();
    registerApplyPatchTool(registry.pi as any);
    const tool = registry.getTool("apply_patch");
    const content = Array.from({ length: 60 }, (_, index) => `+line-${index + 1}`);
    const call = render(tool.renderCall({
      patchText: patch("*** Add File: large.txt", ...content, "*** Delete File: later-delete.txt"),
    }, {} as any, { cwd: "/repo", argsComplete: true }));

    expect(call).toContain("Targets: A large.txt, D later-delete.txt");
    expect(call).toContain("A large.txt");
    expect(call).toContain("+line-1");
    expect(call).toContain("+line-60");
    expect(call).not.toContain("more patch lines");

    const longPath = `${"x".repeat(200)}.txt`;
    const manyTargets = render(tool.renderCall({
      patchText: patch(
        `*** Add File: ${longPath}`,
        ...Array.from({ length: 20 }, (_, index) => `*** Add File: file-${index + 2}.txt`),
      ),
    }, {} as any, { cwd: "/repo", argsComplete: true }));
    expect(manyTargets).toContain(`A ${"x".repeat(155)}...`);
    expect(manyTargets).toContain("... (1 more targets)");
    expect(manyTargets).not.toContain(longPath);
  });

  it("applies Add/Update/Delete and returns concise multi-file diff metadata", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "update.txt"), "old\n", "utf8");
    await writeFile(join(root, "delete.txt"), "gone\n", "utf8");
    const registry = createToolRegistry();
    registerApplyPatchTool(registry.pi as any);

    const result = await registry.getTool("apply_patch").execute("ok", {
      workdir: root,
      patchText: patch(
        "*** Add File: nested/add.txt",
        "+created",
        "*** Update File: update.txt",
        "@@",
        "-old",
        "+new",
        "*** Delete File: delete.txt",
      ),
    }, undefined, undefined, { cwd: "/unused" });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toBe("Applied patch successfully (3 files): A nested/add.txt, M update.txt, D delete.txt");
    expect(result.details.partial).toBe(false);
    expect(result.details.files).toMatchObject([
      { operation: "add", path: "nested/add.txt", addedLines: 1, removedLines: 0 },
      { operation: "update", path: "update.txt", addedLines: 1, removedLines: 1 },
      { operation: "delete", path: "delete.txt", addedLines: 0, removedLines: 1 },
    ]);
    for (const file of result.details.files) {
      expect(file).not.toHaveProperty("before");
      expect(file).not.toHaveProperty("after");
    }
    expect(result.details.files[1].diff).toContain("-old");
    expect(result.details.files[1].diff).toContain("+new");
    expect(await readFile(join(root, "nested/add.txt"), "utf8")).toBe("created\n");
    expect(await readFile(join(root, "update.txt"), "utf8")).toBe("new\n");
    expect(await exists(join(root, "delete.txt"))).toBe(false);
  });

  it("resolves relative patch paths from explicit workdir instead of the session cwd", async () => {
    // Intent: a workspace patch must not silently modify an identically named file
    // in the session root when the caller selected another working directory.
    const root = await createTempWorkspace();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(root, "same.txt"), "old\n", "utf8");
    await writeFile(join(workspace, "same.txt"), "old\n", "utf8");
    const registry = createToolRegistry();
    registerApplyPatchTool(registry.pi as any);

    const result = await registry.getTool("apply_patch").execute("workdir", {
      workdir: "workspace",
      patchText: patch("*** Update File: same.txt", "@@", "-old", "+new"),
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "same.txt"), "utf8")).toBe("old\n");
    expect(await readFile(join(workspace, "same.txt"), "utf8")).toBe("new\n");
  });

  it("uses a singular summary and renders results with or without diff metadata", async () => {
    // Intent: empty-file creation has metadata but no hunk, while ordinary errors may have no file metadata.
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    registerApplyPatchTool(registry.pi as any);
    const tool = registry.getTool("apply_patch");
    const result = await tool.execute("single", {
      workdir: root,
      patchText: patch("*** Add File: empty.txt"),
    });

    expect(getText(result)).toBe("Applied patch successfully (1 file): A empty.txt");
    expect(result.details.files[0]).toMatchObject({ diff: "", addedLines: 0, removedLines: 0 });
    const withoutDiff = render(tool.renderResult(result, { expanded: true, isPartial: false }, {} as any, { cwd: root, isError: false }));
    expect(withoutDiff).toContain("A empty.txt (+0 -0)");
    expect(withoutDiff).not.toContain("diff:");

    const plain = render(tool.renderResult(
      { content: [{ type: "text", text: "plain result" }] },
      { expanded: true, isPartial: false },
      {} as any,
      { cwd: root, isError: false },
    ));
    expect(plain).toContain("plain result");
    const emptyMetadata = render(tool.renderResult(
      { content: [{ type: "text", text: "empty metadata" }], details: { files: [] } },
      { expanded: true, isPartial: false },
      {} as any,
      { cwd: root, isError: false },
    ));
    expect(emptyMetadata).toContain("empty metadata");

    const metadataOnly = render(tool.renderResult(
      { content: [], details: { files: [{ operation: "add", path: "x", absolutePath: "/x", diff: "", addedLines: 0, removedLines: 0 }] } },
      { expanded: true, isPartial: false },
      {} as any,
      { cwd: root, isError: false },
    ));
    expect(metadataOnly).toContain("A x (+0 -0)");
  });

  it("renders compact targets in the call and per-file diffs in the result", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "a.txt"), "old\n", "utf8");
    const registry = createToolRegistry();
    registerApplyPatchTool(registry.pi as any);
    const tool = registry.getTool("apply_patch");
    const args = {
      workdir: root,
      patchText: patch("*** Update File: a.txt", "@@", "-old", "+new"),
    };

    const call = render(tool.renderCall(args, {} as any, { cwd: "/unused", argsComplete: true }));
    expect(call).toContain(`apply_patch in ${root}`);
    expect(call).toContain("M a.txt");
    expect(call).toContain("-old");
    expect(call).toContain("+new");
    expect(call).not.toContain("*** Begin Patch");

    const result = await tool.execute("render", args, undefined, undefined, { cwd: "/unused" });
    const renderedResult = render(tool.renderResult(result, { expanded: true, isPartial: false }, {} as any, { cwd: root, isError: false }));
    expect(renderedResult).toContain("M a.txt (+1 -1)");
    expect(renderedResult).toContain("-old");
    expect(renderedResult).toContain("+new");
  });

  it("bounds update diff metadata to nearby unified-hunk context", async () => {
    // Intent: a one-line edit in a large file must not retain or render the entire unchanged file.
    const root = await createTempWorkspace();
    const source = Array.from({ length: 120 }, (_, index) => `line-${index + 1}`).join("\n") + "\n";
    await writeFile(join(root, "large.txt"), source, "utf8");
    const registry = createToolRegistry();
    registerApplyPatchTool(registry.pi as any);
    const result = await registry.getTool("apply_patch").execute("large", {
      workdir: root,
      patchText: patch("*** Update File: large.txt", "@@", "-line-60", "+line-60-updated"),
    }, undefined, undefined, { cwd: root });

    const metadata = result.details.files[0];
    expect(metadata).toMatchObject({ addedLines: 1, removedLines: 1 });
    expect(metadata.diff).toContain("@@ -");
    expect(metadata.diff).toContain(" line-56");
    expect(metadata.diff).toContain(" line-64");
    expect(metadata.diff).toContain("-line-60");
    expect(metadata.diff).toContain("+line-60-updated");
    expect(metadata.diff).not.toContain("line-1\n");
    expect(metadata.diff).not.toContain("line-120");
    expect(metadata.diff.split("\n").length).toBeLessThan(15);
  });

  it("bounds retained diff metadata while preserving full change counts", async () => {
    // Intent: changed content can be arbitrarily large, but persisted tool details cannot.
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    registerApplyPatchTool(registry.pi as any);
    const added = [
      `+${"x".repeat(600)}`,
      ...Array.from({ length: 449 }, (_, index) => `+line-${index + 2}`),
    ];

    const result = await registry.getTool("apply_patch").execute("bounded-diff", {
      workdir: root,
      patchText: patch("*** Add File: large-add.txt", ...added),
    }, undefined, undefined, { cwd: root });

    const metadata = result.details.files[0];
    expect(metadata).toMatchObject({ addedLines: 450, removedLines: 0 });
    expect(metadata.diff.split("\n").length).toBe(400);
    expect(metadata.diff).toContain("more diff lines omitted");
    expect(metadata.diff.split("\n")[1]?.length).toBe(500);
  });

  it("normalizes CR and mixed endings only for diff rendering and line counts", async () => {
    // Intent: the diff package is LF-oriented, while the committed file must keep
    // its original per-line endings and missing-final-ending state.
    const root = await createTempWorkspace();
    await writeFile(join(root, "cr.txt"), "a\rb\r", "utf8");
    await writeFile(join(root, "mixed.txt"), "a\r\nb\nc\rd", "utf8");
    const registry = createToolRegistry();
    registerApplyPatchTool(registry.pi as any);

    const result = await registry.getTool("apply_patch").execute("eol-diff", {
      workdir: root,
      patchText: patch(
        "*** Update File: cr.txt",
        "@@",
        "-b",
        "+B",
        "*** Update File: mixed.txt",
        "@@",
        "-b",
        "+B",
      ),
    }, undefined, undefined, { cwd: root });

    expect(result.details.files).toMatchObject([
      { path: "cr.txt", addedLines: 1, removedLines: 1 },
      { path: "mixed.txt", addedLines: 1, removedLines: 1 },
    ]);
    expect(result.details.files[0].diff).toContain(" a\n-b\n+B");
    expect(result.details.files[0].diff).not.toContain("\r");
    expect(result.details.files[1].diff).not.toContain("\r");
    expect(await readFile(join(root, "cr.txt"), "utf8")).toBe("a\rB\r");
    expect(await readFile(join(root, "mixed.txt"), "utf8")).toBe("a\r\nB\nc\rd");
  });

  it("syncs committed Add/Update files and closes committed Delete files in LSP", async () => {
    // Intent: Delete must emit didClose instead of attempting to read the now-missing
    // file, while successful Add and Update retain normal synchronization.
    const root = await createTempWorkspace();
    await writeFile(join(root, "update.txt"), "old\n", "utf8");
    await writeFile(join(root, "delete.txt"), "gone\n", "utf8");
    const sync = vi.spyOn(lspManager, "syncFileIfOpen").mockResolvedValue(undefined);
    const close = vi.spyOn(lspManager, "closeFileIfOpen").mockResolvedValue(undefined);
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const result = await registry.getTool("apply_patch").execute("lsp", {
      workdir: root,
      patchText: patch(
        "*** Add File: add.txt",
        "+created",
        "*** Update File: update.txt",
        "@@",
        "-old",
        "+new",
        "*** Delete File: delete.txt",
      ),
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    expect(sync.mock.calls.map(([path]) => path)).toEqual([
      join(root, "add.txt"),
      join(root, "update.txt"),
    ]);
    expect(close.mock.calls.map(([path]) => path)).toEqual([join(root, "delete.txt")]);
  });

  it("reports a first-file commit race without claiming partial application", async () => {
    // Intent: a create-only Add can lose a race after preflight; with no earlier
    // commit the wrapper must use the explicit non-partial commit-error summary.
    const root = await createTempWorkspace();
    const first = join(root, "first.txt");
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const blocker = withFileMutationQueue(first, async () => {
      started();
      await releasePromise;
    });
    await startedPromise;
    const registry = createToolRegistry();
    registerApplyPatchTool(registry.pi as any);
    const pending = registry.getTool("apply_patch").execute("first-race", {
      workdir: root,
      patchText: patch("*** Add File: first.txt", "+first"),
    }, undefined, undefined, { cwd: root });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(first, "racer\n", "utf8");
    release();
    await blocker;
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Patch failed before any file was committed at first.txt");
    expect(getText(result)).not.toContain("partially applied");
    expect(getText(result)).toContain("The state of first.txt is unknown");
    expect(result.details).toMatchObject({ files: [], partial: false, failedPath: "first.txt", failedPathState: "unknown" });
  });

  it("routes LSP close for a Delete committed before a later patch failure", async () => {
    // Intent: confirmed Delete commits close normally, and an unknown failed path
    // is also closed so an open LSP document cannot retain stale contents.
    const root = await createTempWorkspace();
    const deleted = join(root, "deleted.txt");
    await writeFile(deleted, "gone\n", "utf8");
    const second = join(root, "second.txt");
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const blocker = withFileMutationQueue(second, async () => {
      started();
      await releasePromise;
    });
    await startedPromise;
    const sync = vi.spyOn(lspManager, "syncFileIfOpen").mockResolvedValue(undefined);
    const close = vi.spyOn(lspManager, "closeFileIfOpen").mockResolvedValue(undefined);
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const pending = registry.getTool("apply_patch").execute("partial-lsp", {
      workdir: root,
      patchText: patch("*** Delete File: deleted.txt", "*** Add File: second.txt", "+second"),
    }, undefined, undefined, { cwd: root });
    await waitFor(async () => !(await exists(deleted)));
    await writeFile(second, "racer\n", "utf8");
    release();
    await blocker;
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    expect(close.mock.calls.map(([path]) => path)).toEqual([deleted, second]);
  });

  it("keeps preflight failures non-mutating and exposes partial-commit file details", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    registerApplyPatchTool(registry.pi as any);
    const tool = registry.getTool("apply_patch");

    const preflight = await tool.execute("preflight", {
      workdir: root,
      patchText: patch("*** Add File: untouched.txt", "+created", "*** Delete File: missing.txt"),
    }, undefined, undefined, { cwd: root });
    expect(preflight.isError).toBe(true);
    expect(getText(preflight)).toContain("Patch preflight failed");
    expect(preflight.details.files).toEqual([]);
    expect(await exists(join(root, "untouched.txt"))).toBe(false);

    const second = join(root, "second.txt");
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const blocker = withFileMutationQueue(second, async () => {
      started();
      await releasePromise;
    });
    await startedPromise;

    const pending = tool.execute("partial", {
      workdir: root,
      patchText: patch("*** Add File: first.txt", "+first", "*** Add File: second.txt", "+second"),
    }, undefined, undefined, { cwd: root });
    await waitFor(() => exists(join(root, "first.txt")));
    await writeFile(second, "racer\n", "utf8");
    release();
    await blocker;
    const partial = await pending;

    expect(partial.isError).toBe(true);
    expect(getText(partial)).toContain("Patch partially applied");
    expect(getText(partial)).toContain("The state of second.txt is unknown");
    expect(partial.details).toMatchObject({ partial: true, failedPath: "second.txt", failedPathState: "unknown" });
    expect(partial.details.files).toMatchObject([{ operation: "add", path: "first.txt", addedLines: 1, removedLines: 0 }]);
    expect(partial.details.files[0].absolutePath).toBe(join(root, "first.txt"));
    expect(partial.details.files[0]).not.toHaveProperty("before");
    expect(partial.details.files[0]).not.toHaveProperty("after");
    await rm(second, { force: true });
  });
});
