import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import piBaseExtension from "../index.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

function getAnchor(text: string, lineContent: string): string {
  const line = text.split("\n").find((entry) => entry.includes(`|${lineContent}`));
  if (!line) throw new Error(`No anchor for line containing ${JSON.stringify(lineContent)} in:\n${text}`);
  return line.split("|")[0]!;
}

function getTotalLines(text: string): number {
  const match = text.match(/totalLines: (\d+)/);
  if (!match) throw new Error(`No totalLines in:\n${text}`);
  return Number(match[1]);
}

describe("edit: empty new_text semantics", () => {
  it("replace_lines with new_text \"\" blanks the line in place (does not delete it)", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const initialRead = await registry.getTool("read").execute("1", { path: "f.txt" }, undefined, undefined, { cwd: root });
    const initialText = getText(initialRead);
    expect(getTotalLines(initialText)).toBe(4);

    const anchor = getAnchor(initialText, "beta");
    const edit = await registry.getTool("edit").execute(
      "2",
      { path: "f.txt", edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "" } }] },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(edit.isError).not.toBe(true);

    const afterRead = await registry.getTool("read").execute("3", { path: "f.txt" }, undefined, undefined, { cwd: root });
    const afterText = getText(afterRead);
    expect(getTotalLines(afterText)).toBe(4);
    const lines = afterText.split("\n");
    const line2 = lines.find((line) => /^ 2:[0-9a-f]{3}\|/.test(line) || /^2:[0-9a-f]{3}\|/.test(line));
    expect(line2).toBeDefined();
    // The body of line 2 must be empty: anchor followed by `|` and nothing else.
    expect(line2!.match(/^.*2:[0-9a-f]{3}\|(\s*)$/)).not.toBeNull();
  });

  it("insert_before with new_text \"\" inserts one empty line before the anchor", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "f.txt"), "aa\nbb\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const initialRead = await registry.getTool("read").execute("1", { path: "f.txt" }, undefined, undefined, { cwd: root });
    const anchor = getAnchor(getText(initialRead), "aa");

    const edit = await registry.getTool("edit").execute(
      "2",
      { path: "f.txt", edits: [{ insert_before: { anchor, new_text: "" } }] },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(edit.isError).not.toBe(true);

    // Original file "aa\nbb\n" splits to 3 lines: ["aa", "bb", ""].
    // Inserting one empty line before line 1 produces "\naa\nbb\n"
    // which splits to 4 lines: ["", "aa", "bb", ""].
    const afterRead = await registry.getTool("read").execute("3", { path: "f.txt" }, undefined, undefined, { cwd: root });
    const afterText = getText(afterRead);
    expect(getTotalLines(afterText)).toBe(4);
    const lines = afterText.split("\n");
    const line1 = lines.find((l) => /^1:[0-9a-f]{3}\|/.test(l));
    const line2 = lines.find((l) => /^2:[0-9a-f]{3}\|/.test(l));
    expect(line1).toBeDefined();
    expect(line1!.match(/^1:[0-9a-f]{3}\|(\s*)$/)).not.toBeNull();
    expect(line2).toBeDefined();
    expect(line2).toMatch(/\|aa$/);
  });

  it("insert_after with new_text \"\" inserts one empty line after the anchor", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "f.txt"), "aa\nbb\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const initialRead = await registry.getTool("read").execute("1", { path: "f.txt" }, undefined, undefined, { cwd: root });
    const anchor = getAnchor(getText(initialRead), "aa");

    const edit = await registry.getTool("edit").execute(
      "2",
      { path: "f.txt", edits: [{ insert_after: { anchor, new_text: "" } }] },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(edit.isError).not.toBe(true);

    // Original "aa\nbb\n" -> 3 lines. After insert_after(1, "") -> "aa\n\nbb\n"
    // -> 4 lines: ["aa", "", "bb", ""].
    const afterRead = await registry.getTool("read").execute("3", { path: "f.txt" }, undefined, undefined, { cwd: root });
    const afterText = getText(afterRead);
    expect(getTotalLines(afterText)).toBe(4);
    const lines = afterText.split("\n");
    const line1 = lines.find((l) => /^1:[0-9a-f]{3}\|/.test(l));
    const line2 = lines.find((l) => /^2:[0-9a-f]{3}\|/.test(l));
    expect(line1).toBeDefined();
    expect(line1).toMatch(/\|aa$/);
    expect(line2).toBeDefined();
    expect(line2!.match(/^2:[0-9a-f]{3}\|(\s*)$/)).not.toBeNull();
  });

  it("delete_lines is the only way to remove lines (replace with \"\" does NOT remove)", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const initialRead = await registry.getTool("read").execute("1", { path: "f.txt" }, undefined, undefined, { cwd: root });
    const anchor = getAnchor(getText(initialRead), "beta");

    const edit = await registry.getTool("edit").execute(
      "2",
      { path: "f.txt", edits: [{ delete_lines: { start_anchor: anchor, end_anchor: anchor } }] },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(edit.isError).not.toBe(true);

    const afterRead = await registry.getTool("read").execute("3", { path: "f.txt" }, undefined, undefined, { cwd: root });
    expect(getTotalLines(getText(afterRead))).toBe(3);
  });
});

describe("find: path is required", () => {
  it("returns isError when path is missing", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("find").execute("1", { pattern: "*.ts" }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/find requires an explicit `path`/);
  });

  it("returns isError when path is empty string", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("find").execute("1", { pattern: "*.ts", path: "" }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/find requires an explicit `path`/);
  });

  it("returns isError when path is whitespace only", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("find").execute("1", { pattern: "*.ts", path: "   " }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/find requires an explicit `path`/);
  });

  it("accepts an explicit \".\" path", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    // We only assert that the call does not produce the "requires path" error;
    // whether matches are returned depends on upstream fd, which is irrelevant
    // for this test of the required-path contract.
    const result = await registry.getTool("find").execute("1", { pattern: "*.ts", path: "." }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    const text = getText(result);
    expect(text).not.toMatch(/find requires an explicit `path`/);
  });
});

describe("grep: binary files are rejected before upstream runs", () => {
  it("returns isError for a binary file path", async () => {
    const root = await createTempWorkspace();
    // Build a small binary file (null bytes).
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(root, "definitely.bin"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("grep").execute("1", { pattern: "a", path: "definitely.bin" }, undefined, undefined, { cwd: root });
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
    const result = await registry.getTool("grep").execute("1", { pattern: "a", path: "definitely.bin", timeoutSeconds: 5 }, undefined, undefined, { cwd: root });
    const elapsed = Date.now() - start;
    expect(result.isError).toBe(true);
    // The check is in-process and synchronous-ish; it must NOT take the full timeout.
    expect(elapsed).toBeLessThan(2000);
  });
});
