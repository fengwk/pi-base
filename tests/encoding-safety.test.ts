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

  it("refuses a UTF-8 HTML page that declares a legacy encoding", async () => {
    // Intent: defect 2 — the declaration used to win over valid UTF-8, so read
    // showed mojibake and an edit wrote GBK bytes into the UTF-8 file.
    const root = await createTempWorkspace();
    const registry = tools();
    const file = join(root, "page.html");
    const bytes = Buffer.from('<!doctype html>\n<html><head><meta charset="gb2312"></head>\n<p>中文</p>\n', "utf8");
    await writeFile(file, bytes);

    const read = await run(registry, "read", root, { path: "page.html" });
    expect(read.isError).toBe(true);
    expect(getText(read)).toContain("Declared text encoding GBK");

    const edit = await run(registry, "edit", root, { path: "page.html", edits: [{ old_string: "<p>", new_string: "<p>你好" }] });
    expect(edit.isError).toBe(true);
    expect(await readFile(file)).toEqual(bytes);
  });

  it("refuses a legacy declaration on UTF-8 content whose non-ASCII text is past the probe", async () => {
    // Intent: ASCII-only early bytes must not let a gb2312 declaration decode later
    // Chinese as GBK; the conflict rule has to scan the whole file.
    const root = await createTempWorkspace();
    const registry = tools();
    const file = join(root, "page.html");
    const body = `<html><head><meta charset="gb2312"></head>\n<p>${"a".repeat(8100)}你好</p>\n`;
    const bytes = Buffer.from(body, "utf8");
    await writeFile(file, bytes);

    const read = await run(registry, "read", root, { path: "page.html" });
    expect(read.isError).toBe(true);
    expect(getText(read)).toContain("Declared text encoding GBK");

    const edit = await run(registry, "edit", root, { path: "page.html", edits: [{ old_string: "<p>", new_string: "<p>ok " }] });
    expect(edit.isError).toBe(true);

    const write = await run(registry, "write", root, { path: "page.html", content: "<html><body>你好</body></html>\n" });
    expect(write.isError).toBe(true);

    expect(await readFile(file)).toEqual(bytes);
  });

  it.each([
    { encoding: "gbk", text: "中文测试" },
    { encoding: "big5", text: "繁體中文" },
    { encoding: "euc-kr", text: "한국어" },
    { encoding: "shift_jis", text: "テスト" },
    { encoding: "windows-1252", text: "caf\u00e9" },
  ])("rejects undeclared $encoding bytes instead of guessing", async ({ encoding, text }) => {
    // Intent: defect 3 — short legacy samples were statistically misdetected
    // (KOI8-R, windows-1255, windows-1252) or even classified as binary.
    const root = await createTempWorkspace();
    const registry = tools();
    const bytes = iconv.encode(`${text}\n`, encoding);
    await writeFile(join(root, "sample.txt"), bytes);

    const read = await run(registry, "read", root, { path: "sample.txt" });
    expect(read.isError).toBe(true);
    expect(getText(read)).toContain("is not UTF-8 text and declares no encoding, so it was not read.");
    expect(await readFile(join(root, "sample.txt"))).toEqual(bytes);
  });

  it("rejects an undeclared legacy file in read, edit and write", async () => {
    // Intent: without a declaration there is no deterministic encoding, so no
    // tool may rewrite the bytes.
    const root = await createTempWorkspace();
    const registry = tools();
    const bytes = iconv.encode("state=old 名称\n", "gbk");
    const file = join(root, "sample.txt");
    await writeFile(file, bytes);

    const read = await run(registry, "read", root, { path: "sample.txt" });
    expect(read.isError).toBe(true);
    expect(getText(read)).toContain("so it was not read.");
    const edit = await run(registry, "edit", root, { path: "sample.txt", edits: [{ old_string: "state=old", new_string: "state=new" }] });
    expect(edit.isError).toBe(true);
    expect(getText(edit)).toContain("so it was not edited.");
    const write = await run(registry, "write", root, { path: "sample.txt", content: "state=done\n" });
    expect(write.isError).toBe(true);
    expect(getText(write)).toContain("so it was not written.");
    expect(await readFile(file)).toEqual(bytes);
  });

  it("searches declared legacy text by its decoded text and lists files it cannot decode", async () => {
    // Intent: defect 5 — grep searched raw bytes, so decoded Chinese text never
    // matched, and matched lines were re-guessed per line into mojibake.
    const root = await createTempWorkspace();
    const registry = tools();
    await writeFile(join(root, "legacy.py"), iconv.encode("# coding: gbk\nstate=old 名称\n", "gbk"));
    await writeFile(join(root, "unknown.txt"), iconv.encode("state=old 名称\n", "gbk"));

    const declared = await run(registry, "grep", root, { path: ".", pattern: "名称" });
    expect(declared.isError).not.toBe(true);
    expect(getText(declared)).toContain("legacy.py:2: state=old 名称");
    expect(getText(declared)).not.toContain("ĂűłĆ");

    const mixed = await run(registry, "grep", root, { path: ".", pattern: "state=old" });
    expect(getText(mixed)).toContain("legacy.py:2: state=old 名称");
    expect(getText(mixed)).not.toContain("unknown.txt:1:");
    expect(getText(mixed)).toContain("Not searched because the text encoding could not be determined:");
    expect(getText(mixed)).toContain(join(root, "unknown.txt"));
  });

  it("reports a single undecodable file with the read wording", async () => {
    // Intent: a file named directly must be an error, not a silent skip.
    const root = await createTempWorkspace();
    const registry = tools();
    await writeFile(join(root, "sample.txt"), iconv.encode("中文\n", "gbk"));

    const result = await run(registry, "grep", root, { path: "sample.txt", pattern: "中文" });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("is not UTF-8 text and declares no encoding, so it was not searched.");
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
