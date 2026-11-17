import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerEditTool } from "../src/edit.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

function createEdit() {
  const registry = createToolRegistry();
  registerEditTool(registry.pi as never);
  return registry.getTool("edit");
}

async function execute(tool: any, root: string, edits: unknown) {
  return tool.execute("batch", { path: "example.txt", edits }, undefined, undefined, { cwd: root });
}

describe("edit batches", () => {
  it.each([1, 2])("uses the same required edits array for %i replacement entries", (entryCount) => {
    // Intent: there is one public input shape; single changes use one entry and path aliases still work.
    const edit = createEdit();
    const edits = [{ old_string: "alpha", new_string: "A" }, { old_string: "beta", new_string: "B", replace_all: true }].slice(0, entryCount);
    expect(edit.prepareArguments({ file_path: "example.txt", edits })).toEqual({ path: "example.txt", edits });
    expect(edit.parameters.required).toContain("edits");
    expect(edit.parameters.properties).not.toHaveProperty("old_string");
    expect(edit.parameters.properties).not.toHaveProperty("new_string");
    expect(edit.parameters.properties).not.toHaveProperty("replace_all");
  });

  it("matches all replacements against the original file and combines the diff and counts", async () => {
    // Intent: new text from one replacement must not be edited again by another batch entry.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "example.txt", "alpha\nbeta\nbeta\n");
    const result = await execute(createEdit(), root, [
      { old_string: "alpha", new_string: "beta" },
      { old_string: "beta", new_string: "gamma", replace_all: true },
    ]);
    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe("beta\ngamma\ngamma\n");
    expect(result.details.replacements).toBe(3);
    expect(result.details.firstChangedLine).toBe(1);
    expect(result.details.diff).toContain("+2|gamma");
    expect(result.details).not.toHaveProperty("oldText");
    expect(result.details).not.toHaveProperty("newText");
  });

  it.each(["alpha\r\nkeep\n", "alpha\nkeep\r\n"])("accepts unchanged entries alongside real edits (new text %j)", async (newText) => {
    // Intent: literal and LF-normalized no-ops must preserve mixed EOL/BOM bytes
    // and must not become the first changed line, even when another edit adds a line.
    const root = await createTempWorkspace();
    const file = join(root, "example.txt");
    const bom = Buffer.from([0xff, 0xfe]);
    await writeFile(file, Buffer.concat([bom, Buffer.from("alpha\r\nkeep\nbeta\r\ngamma\n", "utf16le")]));
    const result = await execute(createEdit(), root, [
      { old_string: "alpha\r\nkeep\n", new_string: newText },
      { old_string: "beta", new_string: "B\nC" },
      { old_string: "gamma", new_string: "gamma" },
    ]);
    expect(result.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(Buffer.concat([bom, Buffer.from("alpha\r\nkeep\nB\nC\r\ngamma\n", "utf16le")]));
    expect(result.details.replacements).toBe(3);
    expect(result.details.firstChangedLine).toBe(3);
    expect(result.details.diff).toContain("+3|B");
    expect(result.details.diff).toContain("+4|C");
  });

  it("validates and counts unchanged replace_all matches in a changed batch", async () => {
    // Intent: accepted no-ops retain replace_all's existing matched-occurrence count.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "example.txt", "alpha\nbeta\nbeta\n");
    const result = await execute(createEdit(), root, [
      { old_string: "beta", new_string: "beta", replace_all: true },
      { old_string: "alpha", new_string: "A" },
    ]);
    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe("A\nbeta\nbeta\n");
    expect(result.details.replacements).toBe(3);
    expect(result.details.firstChangedLine).toBe(1);
  });

  it.each([
    {
      name: "all entries are unchanged",
      original: Buffer.from("alpha\nbeta\n"),
      edits: [{ old_string: "alpha", new_string: "alpha" }, { old_string: "beta", new_string: "beta" }],
    },
    {
      name: "different entries cancel out",
      original: Buffer.from("alpha\nbeta\n"),
      edits: [{ old_string: "alpha\n", new_string: "" }, { old_string: "beta", new_string: "alpha\nbeta" }],
    },
    {
      name: "replacement decoding would change the original bytes",
      original: Buffer.from([0x61, 0xff, 0x0a]),
      edits: [{ old_string: "a\uFFFD", new_string: "a\uFFFD" }],
    },
  ])("rejects without writing when the complete result is unchanged: $name", async ({ original, edits }) => {
    // Intent: compare the whole decoded result before encoding, so no-op batches
    // cannot rewrite bytes/mtime or notify observers, even with invalid source bytes.
    const root = await createTempWorkspace();
    const file = join(root, "example.txt");
    await writeFile(file, original);
    await utimes(file, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    const before = await stat(file);
    const registry = createToolRegistry();
    let successfulEdits = 0;
    const tool = registerEditTool(registry.pi as never, { onSuccessfulEdit: () => { successfulEdits++; } });
    const result = await execute(tool, root, edits);
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("No changes to apply: edit would not change the file.");
    expect(await readFile(file)).toEqual(original);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(successfulEdits).toBe(0);
  });

  it.each([
    {},
    { old_string: "alpha", new_string: "A" },
    { edits: [] },
    { edits: [{ old_string: "alpha" }] },
    { edits: null },
    { edits: [{ old_string: "alpha", new_string: "A" }], old_string: "alpha", new_string: "A" },
    { edits: [{ old_string: "alpha", new_string: "A" }], replace_all: false },
  ])("rejects missing, malformed or top-level replacement arguments before writing: %j", async (args) => {
    // Intent: both schema validation and direct execute enforce one input shape without a legacy fallback.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "example.txt", "alpha\n");
    const tool = createEdit();
    expect(() => tool.prepareArguments({ path: "example.txt", ...args })).toThrow();
    const result = await tool.execute("invalid", { path: "example.txt", ...args }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe("alpha\n");
  });

  it.each([
    { entry: { old_string: "missing", new_string: "M" }, error: "Edit 2: Could not find old_string" },
    { entry: { old_string: "beta", new_string: "B" }, error: "Edit 2: Found 2 exact matches" },
    { entry: { old_string: "", new_string: "B" }, error: "Edit 2: old_string must not be empty" },
    { entry: { old_string: "missing", new_string: "missing" }, error: "Edit 2: Could not find old_string" },
    { entry: { old_string: "beta", new_string: "beta" }, error: "Edit 2: Found 2 exact matches" },
  ])("leaves the file unchanged when a later entry fails: $error", async ({ entry, error }) => {
    // Intent: all entries, including no-ops, must pass matching before any write.
    const root = await createTempWorkspace();
    const original = "alpha\nbeta\nbeta\n";
    await writeWorkspaceFile(root, "example.txt", original);
    const result = await execute(createEdit(), root, [{ old_string: "alpha", new_string: "A" }, entry]);
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain(error);
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(original);
  });

  it.each([
    { old_string: "alpha", new_string: "alpha" },
    { old_string: "alpha", new_string: "other" },
    { old_string: "pha\nbet", new_string: "other" },
  ])("rejects duplicate or overlapping original-file regions: %j", async (entry) => {
    // Intent: overlapping entries, including duplicate edits, must not be applied in an arbitrary order.
    const root = await createTempWorkspace();
    const original = "alpha\nbeta\n";
    await writeWorkspaceFile(root, "example.txt", original);
    const result = await execute(createEdit(), root, [{ old_string: "alpha", new_string: "A" }, entry]);
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Edit 1 and Edit 2 overlap");
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(original);
  });

  it("checks overlap after expanding replace_all across batch entries", async () => {
    // Intent: each rule may be valid alone while one of its expanded regions collides with another rule.
    const root = await createTempWorkspace();
    const original = "alpha alpha\nbeta\n";
    await writeWorkspaceFile(root, "example.txt", original);
    const result = await execute(createEdit(), root, [
      { old_string: "alpha", new_string: "A", replace_all: true },
      { old_string: "pha a", new_string: "B" },
    ]);
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("overlap");
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(original);
  });

  it.each([false, true])("rejects overlapping replace_all entries regardless of input order (reversed=%s)", async (reverse) => {
    // Intent: both rules can have multiple valid matches, but expanded cross-rule overlaps must reject the whole batch.
    const root = await createTempWorkspace();
    const original = "alpha beta\nalpha beta\n";
    await writeWorkspaceFile(root, "example.txt", original);
    const edits = [
      { old_string: "alpha", new_string: "A", replace_all: true },
      { old_string: "alpha beta", new_string: "pair", replace_all: true },
    ];
    const result = await execute(createEdit(), root, reverse ? edits.reverse() : edits);
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("overlap");
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(original);
  });

  it("rejects a batch that depends on text introduced by an earlier entry", async () => {
    // Intent: batches are independent snapshot edits, not sequential transformations.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "example.txt", "alpha\n");
    const result = await execute(createEdit(), root, [
      { old_string: "alpha", new_string: "beta" },
      { old_string: "beta", new_string: "gamma" },
    ]);
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Edit 2: Could not find old_string");
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe("alpha\n");
  });

  it("preserves encoding, BOM, mixed EOL and a later edit's inserted newline", async () => {
    // Intent: descending application must not restore an original CRLF over a later same-line insertion.
    const root = await createTempWorkspace();
    const file = join(root, "example.txt");
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("alpha beta\r\ngamma\n", "utf16le")]));
    const result = await execute(createEdit(), root, [
      { old_string: "gamma", new_string: "G" },
      { old_string: "beta", new_string: "B\nC" },
      { old_string: "alpha", new_string: "A" },
    ]);
    expect(result.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("A B\nC\r\nG\n", "utf16le")]));
  });

  it("does not partially write a batch when a declared encoding cannot represent its output", async () => {
    // Intent: encoding round-trip failure remains an all-before-write validation for batches.
    const root = await createTempWorkspace();
    const file = join(root, "example.py");
    const original = Buffer.from("# coding: latin-1\ncafé\nolé\n", "latin1");
    await writeFile(file, original);
    const result = await createEdit().execute("batch", {
      path: "example.py",
      edits: [
        { old_string: "café", new_string: "coffee" },
        { old_string: "olé", new_string: "漢字" },
      ],
    }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('The resulting text cannot be encoded in ISO-8859-1: "漢" (U+6F22)');
    expect(await readFile(file)).toEqual(original);
  });

  it("previews every entry and labels a batch without including file snapshots", () => {
    // Intent: the TUI must not hide batch edits behind an empty single-edit preview.
    const tool = createEdit();
    const component = tool.renderCall({
      path: "example.txt",
      edits: [{ old_string: "alpha", new_string: "A" }, { old_string: "beta", new_string: "B", replace_all: true }],
    }, {} as any, { cwd: "/tmp", lastComponent: undefined });
    const text = component.render(160).join("\n");
    expect(text).toContain("[2 edits]");
    expect(text).toContain("Edit 1");
    expect(text).toContain("Edit 2 [replace_all]");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
  });
});
