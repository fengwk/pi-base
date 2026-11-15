import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

function tools() {
  const registry = createToolRegistry();
  piBaseExtension(registry.pi as never);
  return registry;
}

async function run(registry: ReturnType<typeof tools>, name: string, cwd: string, args: Record<string, unknown>) {
  return registry.getTool(name).execute("encoding", { workdir: ".", ...args }, undefined, undefined, { cwd });
}

const DECLARED_FILES = [
  { name: "GBK", filePath: "sample.py", prefix: "# coding: gbk\n", encoding: "gbk", text: "中文测试" },
  { name: "Big5", filePath: "sample.html", prefix: '<html><head><meta charset="big5"></head>\n', encoding: "big5", text: "繁體中文" },
  { name: "Shift_JIS", filePath: "sample.rb", prefix: "# encoding: shift_jis\n", encoding: "shift_jis", text: "テスト" },
  { name: "windows-1252", filePath: "sample.css", prefix: '@charset "windows-1252";\n', encoding: "windows-1252", text: "café €" },
  { name: "ISO-8859-1", filePath: "sample.py", prefix: "# coding: latin-1\n", encoding: "latin1", text: "café" },
];

describe("text encoding safety", () => {
  it("reads a Markdown note whose first line only looks like a coding cookie", async () => {
    // Intent: defect 1 — `# Notes on coding: style` in Markdown used to fail with
    // "Unsupported declared text encoding: style.".
    const root = await createTempWorkspace();
    const registry = tools();
    await writeFile(join(root, "notes.md"), "# Notes on coding: style\n中文内容\n", "utf8");

    const read = await run(registry, "read", root, { path: "notes.md" });

    expect(read.isError).not.toBe(true);
    expect(getText(read)).toContain("# Notes on coding: style");
    expect(getText(read)).toContain("中文内容");
    expect(getText(read)).not.toContain("encoding:");
  });

  it("accepts a valid PEP 263 coding cookie with a suffix", async () => {
    // Intent: defect 1 — `utf-8-unix` is a valid Python coding cookie.
    const root = await createTempWorkspace();
    const registry = tools();
    await writeFile(join(root, "sample.py"), "# -*- coding: utf-8-unix -*-\nprint('中文')\n", "utf8");

    const read = await run(registry, "read", root, { path: "sample.py" });

    expect(read.isError).not.toBe(true);
    expect(getText(read)).toContain("print('中文')");
    expect(getText(read)).not.toContain("encoding:");
  });

  it.each(DECLARED_FILES)("round-trips a declared $name file through read, edit and write", async ({ name, filePath, prefix, encoding, text }) => {
    // Intent: a declaration selects the encoding for every tool, and the exact
    // expected bytes survive edits and whole-file rewrites.
    const root = await createTempWorkspace();
    const registry = tools();
    const content = `${prefix}${text}\nstate=old\n`;
    const file = join(root, filePath);
    await writeFile(file, iconv.encode(content, encoding));

    const read = await run(registry, "read", root, { path: filePath });
    expect(read.isError).not.toBe(true);
    expect(getText(read)).toContain(`encoding: ${name}`);
    expect(getText(read)).toContain(text);

    const edit = await run(registry, "edit", root, { path: filePath, edits: [{ old_string: "state=old", new_string: "state=new" }] });
    expect(edit.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(iconv.encode(content.replace("state=old", "state=new"), encoding));

    const write = await run(registry, "write", root, { path: filePath, content: content.replace("state=old", "state=done") });
    expect(write.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(iconv.encode(content.replace("state=old", "state=done"), encoding));
  });

  it("honors a GBK declaration over bytes that are also valid UTF-8", async () => {
    // Intent: a declaration is authoritative even when the bytes are valid UTF-8;
    // read, edit and write stay on the decoded GBK view instead of rejecting the file.
    const root = await createTempWorkspace();
    const registry = tools();
    const file = join(root, "sample.py");
    await writeFile(file, Buffer.from("# coding: gbk\nabc茅xyz\n", "utf8"));

    const read = await run(registry, "read", root, { path: "sample.py" });
    expect(read.isError).not.toBe(true);
    expect(getText(read)).toContain("encoding: GBK");
    expect(getText(read)).toContain("abc鑼厁yz");
    expect(getText(read)).not.toContain("茅");

    const edit = await run(registry, "edit", root, { path: "sample.py", edits: [{ old_string: "鑼厁", new_string: "c" }] });
    expect(edit.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(iconv.encode("# coding: gbk\nabccyz\n", "gbk"));

    const write = await run(registry, "write", root, { path: "sample.py", content: "# coding: gbk\nabcdyz\n" });
    expect(write.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(iconv.encode("# coding: gbk\nabcdyz\n", "gbk"));
  });

  it("reads invalid UTF-8 as U+FFFD and edits the displayed text back to valid UTF-8", async () => {
    // Intent: read and edit share one replacement-decoded view, so the exact text
    // read shows, including U+FFFD, is what edit matches and writes.
    const root = await createTempWorkspace();
    const registry = tools();
    const file = join(root, "sample.txt");
    await writeFile(file, Buffer.from([0x61, 0x62, 0x63, 0xff, 0xef, 0xbc, 0x8c, 0x65, 0x0a]));

    const read = await run(registry, "read", root, { path: "sample.txt" });
    expect(read.isError).not.toBe(true);
    expect(getText(read)).toContain("abc\uFFFD，e");

    const edit = await run(registry, "edit", root, { path: "sample.txt", edits: [{ old_string: "\uFFFD，", new_string: "c" }] });
    expect(edit.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(Buffer.from("abcce\n", "utf8"));
  });

  it("uses replacement-decoded UTF-8 for read, edit and write on undeclared legacy bytes", async () => {
    // Intent: without a declaration the tools share the UTF-8 replacement view
    // instead of refusing the file; writes then normalize the bytes to valid UTF-8.
    const root = await createTempWorkspace();
    const registry = tools();
    const bytes = iconv.encode("state=old 名称\n", "gbk");
    const decoded = bytes.toString("utf8");
    const file = join(root, "sample.txt");
    await writeFile(file, bytes);

    const read = await run(registry, "read", root, { path: "sample.txt" });
    expect(read.isError).not.toBe(true);
    expect(getText(read)).toContain("state=old");
    expect(getText(read)).toContain("\uFFFD");
    expect(getText(read)).not.toContain("encoding:");

    const edit = await run(registry, "edit", root, { path: "sample.txt", edits: [{ old_string: "state=old", new_string: "state=new" }] });
    expect(edit.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(Buffer.from(decoded.replace("state=old", "state=new"), "utf8"));

    const write = await run(registry, "write", root, { path: "sample.txt", content: "state=done\n" });
    expect(write.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(Buffer.from("state=done\n", "utf8"));
  });

  it("refuses to leave U+FFFD in a declared GBK file until it is removed", async () => {
    // Intent: replacement decoding is readable, but output must stay representable;
    // an edit that still contains U+FFFD fails without touching the file.
    const root = await createTempWorkspace();
    const registry = tools();
    const file = join(root, "sample.py");
    const bytes = Buffer.concat([iconv.encode("# coding: gbk\n", "gbk"), Buffer.from([0xff]), Buffer.from("\n")]);
    await writeFile(file, bytes);

    const read = await run(registry, "read", root, { path: "sample.py" });
    expect(read.isError).not.toBe(true);
    expect(getText(read)).toContain("encoding: GBK");
    expect(getText(read)).toContain("\uFFFD");

    const rejected = await run(registry, "edit", root, {
      path: "sample.py",
      edits: [{ old_string: "# coding: gbk", new_string: "# coding: gbk " }],
    });
    expect(rejected.isError).toBe(true);
    expect(getText(rejected)).toContain("cannot be encoded in GBK");
    expect(await readFile(file)).toEqual(bytes);

    const accepted = await run(registry, "edit", root, { path: "sample.py", edits: [{ old_string: "\uFFFD", new_string: "ok" }] });
    expect(accepted.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(iconv.encode("# coding: gbk\nok\n", "gbk"));
  });

  it("searches declared and undeclared legacy text on their shared decoded view", async () => {
    // Intent: grep searches the same text read shows; declarations select their
    // decoding, and undeclared bytes use UTF-8 replacement decoding instead of a skip.
    const root = await createTempWorkspace();
    const registry = tools();
    await writeFile(join(root, "legacy.py"), iconv.encode("# coding: gbk\nstate=old 名称\n", "gbk"));
    await writeFile(join(root, "unknown.txt"), iconv.encode("state=old 名称\n", "gbk"));

    const declared = await run(registry, "grep", root, { path: ".", pattern: "名称" });
    expect(declared.isError).not.toBe(true);
    expect(getText(declared)).toContain("legacy.py:2: state=old 名称");
    expect(getText(declared)).not.toContain("unknown.txt");
    expect(getText(declared)).not.toContain("ĂűłĆ");

    const replacement = await run(registry, "grep", root, { path: ".", pattern: "\uFFFD" });
    expect(replacement.isError).not.toBe(true);
    expect(getText(replacement)).toContain("unknown.txt:1: state=old");

    const mixed = await run(registry, "grep", root, { path: ".", pattern: "state=old" });
    expect(getText(mixed)).toContain("legacy.py:2: state=old 名称");
    expect(getText(mixed)).toContain("unknown.txt:1: state=old");
    expect(getText(mixed)).not.toContain("Search incomplete");
  });

  it("lists files that cannot be decoded and marks the search incomplete", async () => {
    // Intent: truly unusable declarations stay visible instead of being hidden
    // behind a bare No matches found.
    const root = await createTempWorkspace();
    const registry = tools();
    await writeFile(join(root, "unsupported.py"), "# coding: x-unknown\nstate=old\n", "utf8");
    await writeFile(join(root, "valid.txt"), "state=old\n", "utf8");

    const result = await run(registry, "grep", root, { path: ".", pattern: "state=old" });

    expect(result.isError).not.toBe(true);
    const text = getText(result);
    expect(text).toContain("valid.txt:1: state=old");
    expect(text).toContain("Search incomplete; Not searched:");
    expect(text).toContain(join(root, "unsupported.py"));
    expect(text).not.toContain("unsupported.py:1:");
  });

  it("searches a single file on replacement-decoded text for U+FFFD and ASCII", async () => {
    // Intent: the single-file path must not take a raw-byte shortcut for invalid
    // UTF-8, so both a replacement character and an ASCII key match read's view.
    const root = await createTempWorkspace();
    const registry = tools();
    await writeFile(join(root, "sample.txt"), iconv.encode("中文\nstate=old\n", "gbk"));

    const replacement = await run(registry, "grep", root, { path: "sample.txt", pattern: "\uFFFD" });
    expect(replacement.isError).not.toBe(true);
    expect(getText(replacement)).toContain("sample.txt:1: \uFFFD");

    const ascii = await run(registry, "grep", root, { path: "sample.txt", pattern: "state=old" });
    expect(ascii.isError).not.toBe(true);
    expect(getText(ascii)).toContain("sample.txt:2: state=old");
  });

  it("refuses to drop a declared non-UTF-8 encoding on a whole-file write", async () => {
    // Intent: dropping the declaration would silently reinterpret the bytes as UTF-8.
    const root = await createTempWorkspace();
    const registry = tools();
    const file = join(root, "sample.py");
    await writeFile(file, iconv.encode("# coding: gbk\n中文\n", "gbk"));

    const write = await run(registry, "write", root, { path: "sample.py", content: "中文\n" });

    expect(write.isError).toBe(true);
    expect(getText(write)).toContain("The new content removes the GBK declaration of sample.py.");
    expect(await readFile(file)).toEqual(iconv.encode("# coding: gbk\n中文\n", "gbk"));
  });

  it("refuses an edit that would change the effective encoding", async () => {
    // Intent: changing only the declaration would relabel legacy bytes as UTF-8.
    const root = await createTempWorkspace();
    const registry = tools();
    const file = join(root, "sample.html");
    const bytes = iconv.encode('<html><head><meta charset="gbk"></head>\n<body>中文</body>\n', "gbk");
    await writeFile(file, bytes);

    const edit = await run(registry, "edit", root, {
      path: "sample.html",
      edits: [{ old_string: 'charset="gbk"', new_string: 'charset="utf-8"' }],
    });

    expect(edit.isError).toBe(true);
    expect(getText(edit)).toContain("This change would change the encoding of sample.html from GBK to UTF-8.");
    expect(await readFile(file)).toEqual(bytes);
  });

  it.each(["edit", "write"])("keeps an explicit ASCII declaration enforced during %s", async (name) => {
    // Intent: a declared ASCII file must stay ASCII instead of silently becoming UTF-8.
    const root = await createTempWorkspace();
    const registry = tools();
    const file = join(root, "sample.py");
    const content = "# coding: ASCII\nstate=old\n";
    await writeFile(file, Buffer.from(content, "ascii"));

    const args = name === "edit"
      ? { edits: [{ old_string: "state=old", new_string: "state=中文" }] }
      : { content: content.replace("old", "中文") };
    const result = await run(registry, name, root, { path: "sample.py", ...args });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("cannot be encoded in US-ASCII");
    expect(await readFile(file)).toEqual(Buffer.from(content, "ascii"));
  });

  it.each(["read", "edit", "write"])("rejects binary files during %s", async (name) => {
    // Intent: binary detection is Git's NUL rule, reported by every text tool.
    const root = await createTempWorkspace();
    const registry = tools();
    const file = join(root, "binary.dat");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
    await writeFile(file, bytes);

    const args = name === "edit" ? { edits: [{ old_string: "a", new_string: "b" }] } : name === "write" ? { content: "text\n" } : {};
    const result = await run(registry, name, root, { path: "binary.dat", ...args });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("is a binary file (it contains NUL bytes)");
    expect(await readFile(file)).toEqual(bytes);
  });

  it("keeps a legitimate UTF-8 replacement character while editing", async () => {
    // Intent: U+FFFD is ordinary UTF-8 text; only invalid bytes are undecodable.
    const root = await createTempWorkspace();
    const registry = tools();
    const file = join(root, "sample.txt");
    await writeFile(file, Buffer.from("alpha\n\uFFFD\n", "utf8"));

    const edit = await run(registry, "edit", root, { path: "sample.txt", edits: [{ old_string: "alpha", new_string: "beta" }] });

    expect(edit.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(Buffer.from("beta\n\uFFFD\n", "utf8"));
  });
});
