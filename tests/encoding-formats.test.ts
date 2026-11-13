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
  return registry.getTool(name).execute("formats", { workdir: ".", ...args }, undefined, undefined, { cwd });
}

describe("common text encoding formats", () => {
  it.each([
    { encoding: "UTF-8", codec: "utf-8", bom: [0xef, 0xbb, 0xbf], header: "UTF-8" },
    { encoding: "UTF-16LE", codec: "utf-16le", bom: [0xff, 0xfe], header: "UTF-16LE" },
    { encoding: "UTF-16BE", codec: "utf-16be", bom: [0xfe, 0xff], header: "UTF-16BE" },
    { encoding: "UTF-32LE", codec: "utf-32le", bom: [0xff, 0xfe, 0x00, 0x00], header: "UTF-32LE" },
    { encoding: "UTF-32BE", codec: "utf-32be", bom: [0x00, 0x00, 0xfe, 0xff], header: "UTF-32BE" },
  ])("preserves a $encoding BOM, mixed line endings and non-ASCII edits", async ({ encoding, codec, bom, header }) => {
    // Intent: every supported BOM must survive read, edit and write with exactly
    // the expected bytes.
    const root = await createTempWorkspace();
    const registry = tools();
    const family = encoding.startsWith("UTF-16") ? "utf-16" : encoding.startsWith("UTF-32") ? "utf-32" : "utf-8";
    const text = `<?xml version="1.0" encoding="${family}"?>\r\n中文 日本語\r\nstate=old\nunchanged\r\n`;
    const encode = (value: string) => Buffer.concat([Buffer.from(bom), iconv.encode(value, codec)]);
    const file = join(root, "sample.xml");
    await writeFile(file, encode(text));

    const read = await run(registry, "read", root, { path: "sample.xml" });
    expect(read.isError).not.toBe(true);
    expect(getText(read)).toContain("state=old");
    expect(getText(read)).toContain(header === "UTF-8" ? "ends_with_newline: yes" : `encoding: ${header}`);
    expect(getText(read)).not.toContain("encoding: UTF-8\n");

    const edited = text.replace("state=old", "state=编辑");
    const edit = await run(registry, "edit", root, { path: "sample.xml", edits: [{ old_string: "state=old", new_string: "state=编辑" }] });
    expect(edit.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(encode(edited));

    const rewritten = edited.replace("unchanged", "done");
    const write = await run(registry, "write", root, { path: "sample.xml", content: rewritten });
    expect(write.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(encode(rewritten));
  });

  it("adds a byte order mark when the new content starts with U+FEFF", async () => {
    // Intent: write treats a leading U+FEFF as a request for that encoding's mark.
    const root = await createTempWorkspace();
    const registry = tools();

    const write = await run(registry, "write", root, { path: "bom.txt", content: "\uFEFFhello\n" });

    expect(write.isError).not.toBe(true);
    expect(await readFile(join(root, "bom.txt"))).toEqual(Buffer.from("\uFEFFhello\n", "utf8"));
    const read = await run(registry, "read", root, { path: "bom.txt" });
    expect(getText(read)).toContain("hello");
    expect(getText(read)).not.toContain("encoding:");
  });

  it.each([
    { filePath: "sample.xml", prefix: '<?xml version="1.0" encoding="GBK"?>\n', encoding: "gbk", name: "GBK", text: "中文" },
    { filePath: "sample.css", prefix: '@charset "windows-1252";\n', encoding: "windows-1252", name: "windows-1252", text: "café €" },
    { filePath: "sample.html", prefix: '<!doctype html><html><head><meta charset="big5"></head>\n', encoding: "big5", name: "Big5", text: "中文" },
    { filePath: "sample.py", prefix: "# coding: gbk\n", encoding: "gbk", name: "GBK", text: "中文" },
    { filePath: "sample.rb", prefix: "# encoding: shift_jis\n", encoding: "shift_jis", name: "Shift_JIS", text: "日本語" },
    { filePath: "sample.jsp", prefix: '<%@ page pageEncoding="gbk" %>\n', encoding: "gbk", name: "GBK", text: "中文" },
  ])("writes and keeps the $name declaration of $filePath", async ({ filePath, prefix, encoding, name, text }) => {
    // Intent: write/read/edit all agree on the declaration, and a whole-file
    // rewrite keeps the declared encoding instead of converting to UTF-8.
    const root = await createTempWorkspace();
    const registry = tools();
    const content = `${prefix}${text}\r\nstate=old\n`;

    const created = await run(registry, "write", root, { path: filePath, content });
    expect(created.isError).not.toBe(true);
    expect(await readFile(join(root, filePath))).toEqual(iconv.encode(content, encoding));

    const read = await run(registry, "read", root, { path: filePath });
    expect(getText(read)).toContain(text);
    expect(getText(read)).toContain(`encoding: ${name}`);

    const edit = await run(registry, "edit", root, {
      path: filePath,
      edits: [{ old_string: "state=old", new_string: "state=new" }],
    });
    expect(edit.isError).not.toBe(true);
    expect(await readFile(join(root, filePath))).toEqual(iconv.encode(content.replace("state=old", "state=new"), encoding));

    const rewritten = content.replace("state=old", "state=done");
    const write = await run(registry, "write", root, { path: filePath, content: rewritten });
    expect(write.isError).not.toBe(true);
    expect(await readFile(join(root, filePath))).toEqual(iconv.encode(rewritten, encoding));
  });

  it("refuses a declaration that names an unsupported encoding", async () => {
    // Intent: an explicit but unusable declaration is an error, never a silent fallback.
    const root = await createTempWorkspace();
    const registry = tools();

    const write = await run(registry, "write", root, { path: "sample.py", content: "# coding: x-unknown\n" });

    expect(write.isError).toBe(true);
    expect(getText(write)).toContain('Unsupported declared text encoding "x-unknown"');
  });

  it("keeps declaration-like source strings as ordinary UTF-8", async () => {
    // Intent: only standard declaration positions choose the codec, so source
    // code that mentions a declaration stays UTF-8.
    const root = await createTempWorkspace();
    const registry = tools();
    const content = 'const xml = \'<?xml encoding="GBK"?>\';\nconst s = "中文";\n';

    const write = await run(registry, "write", root, { path: "sample.ts", content });

    expect(write.isError).not.toBe(true);
    expect(await readFile(join(root, "sample.ts"))).toEqual(Buffer.from(content, "utf8"));
  });

  it("keeps a BOM-marked file's encoding when the new content declares another", async () => {
    // Intent: an existing BOM stays authoritative; a conflicting declaration is refused.
    const root = await createTempWorkspace();
    const registry = tools();
    const file = join(root, "sample.xml");
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('<?xml version="1.0" encoding="utf-16"?>\n<body>中文</body>\n', "utf-16le")]);
    await writeFile(file, bytes);

    const write = await run(registry, "write", root, {
      path: "sample.xml",
      content: '<?xml version="1.0" encoding="utf-8"?>\n<body>中文</body>\n',
    });

    expect(write.isError).toBe(true);
    expect(getText(write)).toMatch(/byte order mark/);
    expect(await readFile(file)).toEqual(bytes);
  });
});
