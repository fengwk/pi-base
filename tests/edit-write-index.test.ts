import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import piBaseExtension from "../index.js";
import { registerEditTool } from "../src/edit.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

function extractHeader(text: string): string {
  const header = text.split("\n").find((line) => /^\[[^#\r\n]+#[0-9A-F]{4}\]$/i.test(line));
  if (!header) throw new Error(`No hashline header found in:\n${text}`);
  return header;
}

describe("hashline edit/write flow", () => {
  it("adds retry guidance to edit argument validation failures", () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const editTool = registry.getTool("edit");

    let message = "";
    try {
      editTool.prepareArguments({ workdir: ".", input: 42 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Validation failed for tool \"edit\":");
    expect(message).toContain("input: must be string");
    expect(message).toContain("Adjust the input parameters and re-run the `edit` command.");
  });

  it("write returns a fresh hashline header and numbered file snapshot", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/new.ts", content: "export const demo = 1;\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    const text = getText(result);
    expect(text).toContain("Created src/new.ts.");
    expect(text).toMatch(/^\[src\/new\.ts#[0-9A-F]{4}\]$/m);
    expect(text).toContain("1:export const demo = 1;");
    expect(text).not.toContain("2:");
  });

  it("edits a file using the header from write output", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const writeResult = await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/new.ts", content: "export const demo = 1;\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    const header = extractHeader(getText(writeResult));
    const editInput = `${header}\nSWAP 1.=1:\n+export const demo = 2;`;
    const editResult = await registry.getTool("edit").execute("2", { workdir: ".", input: editInput }, undefined, undefined, { cwd: root });
    expect(editResult.isError).not.toBe(true);
    expect(getText(editResult)).toMatch(/^\[src\/new\.ts#[0-9A-F]{4}\]$/m);
    expect(await readFile(join(root, "src/new.ts"), "utf8")).toBe("export const demo = 2;\n");
  });

  it("supports INS.POST and DEL hunks", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\ngamma\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const header = extractHeader(getText(readResult));
    const patch = `${header}\nINS.POST 1:\n+after-alpha\nDEL 3`;
    const result = await registry.getTool("edit").execute("2", { workdir: ".", input: patch }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "src/example.ts"), "utf8")).toBe("alpha\nafter-alpha\nbeta\n");
  });

  it("rejects block operations and asks for explicit ranges", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "function greet() {\n  return 1;\n}\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const header = extractHeader(getText(readResult));
    const patch = `${header}\nSWAP.BLK 1:\n+function greet() {\n+  return 2;\n+}`;
    const result = await registry.getTool("edit").execute("2", { workdir: ".", input: patch }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Block operations are not supported in pi-base");
    expect(getText(result)).toContain("explicit `SWAP N.=M:`");
  });

  it("rejects stale tags after the file changes", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const header = extractHeader(getText(readResult));
    await writeWorkspaceFile(root, "src/example.ts", "alpha\ngamma\n");
    const patch = `${header}\nSWAP 2.=2:\n+delta`;
    const result = await registry.getTool("edit").execute("2", { workdir: ".", input: patch }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Edit rejected for src/example.ts: file changed between read and edit.");
    expect(getText(result)).toContain("2:gamma");
  });

  it("rejects edits to lines that a partial read never displayed", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\ntwo\nthree\nfour\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const partialRead = await registry.getTool("read").execute(
      "1",
      { workdir: ".", path: "src/example.ts", offset: 2, limit: 2 },
      undefined,
      undefined,
      { cwd: root },
    );
    const header = extractHeader(getText(partialRead));
    const patch = `${header}\nSWAP 4.=4:\n+FOUR`;
    const result = await registry.getTool("edit").execute("2", { workdir: ".", input: patch }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("did not display");
    expect(getText(result)).toContain("copy the fresh header and retry");
  });

  it("rejects inserts that target the interior of an explicit replacement range", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\ntwo\nthree\nfour\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const header = extractHeader(getText(readResult));
    const patch = `${header}\nSWAP 2.=3:\n+TWO\n+THREE\nINS.POST 2:\n+middle`;
    const result = await registry.getTool("edit").execute("2", { workdir: ".", input: patch }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("lands inside explicit range 2.=3");
  });

  it("rejects overlapping explicit ranges", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\ntwo\nthree\nfour\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const header = extractHeader(getText(readResult));
    const patch = `${header}\nSWAP 1.=2:\n+ONE\n+TWO\nDEL 2.=3`;
    const result = await registry.getTool("edit").execute("2", { workdir: ".", input: patch }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("must not overlap");
  });

  it("reports byte-identical no-op edits and escalates after repeated retries", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const header = extractHeader(getText(readResult));
    const patch = `${header}\nSWAP 2.=2:\n+beta`;
    const first = await registry.getTool("edit").execute("2", { workdir: ".", input: patch }, undefined, undefined, { cwd: root });
    const second = await registry.getTool("edit").execute("3", { workdir: ".", input: patch }, undefined, undefined, { cwd: root });
    const third = await registry.getTool("edit").execute("4", { workdir: ".", input: patch }, undefined, undefined, { cwd: root });
    expect(first.isError).toBe(true);
    expect(getText(first)).toContain("produced no change");
    expect(second.isError).toBe(true);
    expect(getText(second)).toContain("produced no change");
    expect(third.isError).toBe(true);
    expect(getText(third)).toContain("byte-identical no-op 3 times in a row");
  });

  it("preflights multi-file patches all-or-nothing", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/a.ts", "one\n");
    await writeWorkspaceFile(root, "src/b.ts", "two\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readA = await registry.getTool("read").execute("1", { workdir: ".", path: "src/a.ts" }, undefined, undefined, { cwd: root });
    const headerA = extractHeader(getText(readA));
    const badHeaderB = `[src/b.ts#DEAD]`;
    const patch = `${headerA}\nSWAP 1.=1:\n+ONE\n\n${badHeaderB}\nSWAP 1.=1:\n+TWO`;
    const result = await registry.getTool("edit").execute("2", { workdir: ".", input: patch }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(await readFile(join(root, "src/a.ts"), "utf8")).toBe("one\n");
    expect(await readFile(join(root, "src/b.ts"), "utf8")).toBe("two\n");
  });

  // Intent: multi-section success path must commit every file and return joined previews (edit-core sections.length > 1 branch).
  it("applies a valid multi-file patch in one edit call", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/a.ts", "one\n");
    await writeWorkspaceFile(root, "src/b.ts", "two\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readA = await registry.getTool("read").execute("1", { workdir: ".", path: "src/a.ts" }, undefined, undefined, { cwd: root });
    const readB = await registry.getTool("read").execute("2", { workdir: ".", path: "src/b.ts" }, undefined, undefined, { cwd: root });
    const headerA = extractHeader(getText(readA));
    const headerB = extractHeader(getText(readB));
    const patch = `${headerA}\nSWAP 1.=1:\n+ONE\n${headerB}\nSWAP 1.=1:\n+TWO`;
    const result = await registry.getTool("edit").execute("3", { workdir: ".", input: patch }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "src/a.ts"), "utf8")).toBe("ONE\n");
    expect(await readFile(join(root, "src/b.ts"), "utf8")).toBe("TWO\n");
    const text = getText(result);
    expect(text).toContain("ONE");
    expect(text).toContain("TWO");
  });

  it("preserves original line endings during edit apply", async () => {
    const root = await createTempWorkspace();
    const file = join(root, "src/example.ts");
    await writeWorkspaceFile(root, "src/example.ts", "placeholder\n");
    await writeFile(file, "alpha\r\nbeta\r\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const header = extractHeader(getText(readResult));
    const patch = `${header}\nSWAP 2.=2:\n+gamma`;
    const result = await registry.getTool("edit").execute("2", { workdir: ".", input: patch }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    expect(await readFile(file, "utf8")).toBe("alpha\r\ngamma\r\n");
  });

  it("edit reports missing input", async () => {
    const registry = createToolRegistry();
    const tool = registerEditTool(registry.pi as any);
    const result = await tool.execute("1", { workdir: "." }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("input is required");
  });
});
