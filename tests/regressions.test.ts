import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import piBaseExtension from "../index.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

function extractHeader(text: string): string {
  const header = text.split("\n").find((line) => /^\[[^#\r\n]+#[0-9A-F]{4}\]$/i.test(line));
  if (!header) throw new Error(`No hashline header found in:\n${text}`);
  return header;
}

describe("hashline explicit-range semantics", () => {
  it("SWAP with a lone '+' blanks the addressed line in place", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "f.txt" }, undefined, undefined, { cwd: root });
    const header = extractHeader(getText(readResult));
    const edit = await registry.getTool("edit").execute("2", { workdir: ".", input: `${header}\nSWAP 2.=2:\n+` }, undefined, undefined, { cwd: root });
    expect(edit.isError).not.toBe(true);
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("alpha\n\ngamma\n");
  });

  it("INS.PRE with a lone '+' inserts one empty line before the anchor", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "f.txt"), "aa\nbb\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "f.txt" }, undefined, undefined, { cwd: root });
    const header = extractHeader(getText(readResult));
    const edit = await registry.getTool("edit").execute("2", { workdir: ".", input: `${header}\nINS.PRE 1:\n+` }, undefined, undefined, { cwd: root });
    expect(edit.isError).not.toBe(true);
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("\naa\nbb\n");
  });

  it("INS.POST with a lone '+' inserts one empty line after the anchor", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "f.txt"), "aa\nbb\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "f.txt" }, undefined, undefined, { cwd: root });
    const header = extractHeader(getText(readResult));
    const edit = await registry.getTool("edit").execute("2", { workdir: ".", input: `${header}\nINS.POST 1:\n+` }, undefined, undefined, { cwd: root });
    expect(edit.isError).not.toBe(true);
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("aa\n\nbb\n");
  });

  it("DEL is the only way to remove addressed lines", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "f.txt" }, undefined, undefined, { cwd: root });
    const header = extractHeader(getText(readResult));
    const edit = await registry.getTool("edit").execute("2", { workdir: ".", input: `${header}\nDEL 2` }, undefined, undefined, { cwd: root });
    expect(edit.isError).not.toBe(true);
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("alpha\ngamma\n");
  });

  it("rejects bare body rows without '+'", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "f.txt"), "alpha\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "f.txt" }, undefined, undefined, { cwd: root });
    const header = extractHeader(getText(readResult));
    const edit = await registry.getTool("edit").execute("2", { workdir: ".", input: `${header}\nSWAP 1.=1:\nalpha` }, undefined, undefined, { cwd: root });
    expect(edit.isError).toBe(true);
    expect(getText(edit)).toContain("Body rows must start with `+`");
  });

  it("rejects blank body rows that are not authored as a lone '+'", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "f.txt"), "alpha\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "f.txt" }, undefined, undefined, { cwd: root });
    const header = extractHeader(getText(readResult));
    const edit = await registry.getTool("edit").execute("2", { workdir: ".", input: `${header}\nSWAP 1.=1:\n` }, undefined, undefined, { cwd: root });
    expect(edit.isError).toBe(true);
  });
});

describe("find: path is required", () => {
  it("returns isError when path is missing", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("find").execute("1", { workdir: ".", pattern: "*.ts" }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/find requires an explicit `path`/);
  });

  it("returns isError when path is empty string", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("find").execute("1", { workdir: ".", pattern: "*.ts", path: "" }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/find requires an explicit `path`/);
  });

  it("returns isError when path is whitespace only", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("find").execute("1", { workdir: ".", pattern: "*.ts", path: "   " }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/find requires an explicit `path`/);
  });

  it("accepts an explicit '.' path", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("find").execute("1", { workdir: ".", pattern: "*.ts", path: "." }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    expect(getText(result)).not.toMatch(/find requires an explicit `path`/);
  });
});

describe("grep: binary files are rejected before upstream runs", () => {
  it("returns isError for a binary file path", async () => {
    const root = await createTempWorkspace();
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(root, "definitely.bin"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("grep").execute("1", { workdir: ".", pattern: "a", path: "definitely.bin" }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/binary file/);
  });

  it("returns isError for a binary file path even when the call is not aborted", async () => {
    const root = await createTempWorkspace();
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(root, "definitely.bin"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const start = Date.now();
    const result = await registry.getTool("grep").execute("1", { workdir: ".", pattern: "a", path: "definitely.bin", timeout_seconds: 5 }, undefined, undefined, { cwd: root });
    const elapsed = Date.now() - start;
    expect(result.isError).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });
});
