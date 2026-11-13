import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { decodeTextFile, detectDeclaredTextEncoding } from "../src/text-codec.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

const declared = [
  { encoding: "utf-8", prefix: '<?xml version="1.0" encoding="UTF-8"?>\n', text: "中文 日本語 café" },
  { encoding: "gbk", prefix: '<?xml version="1.0" encoding="GBK"?>\n', text: "中文" },
  { encoding: "gb18030", prefix: '<?xml version="1.0" encoding="GB18030"?>\n', text: "中文𠮷" },
  { encoding: "big5", prefix: '# -*- coding: big5 -*-\n', text: "中文" },
  { encoding: "shift_jis", prefix: '#!/usr/bin/python\n# coding: shift_jis\n', text: "日本語" },
  { encoding: "iso-8859-1", prefix: '# coding: iso-8859-1\n', text: "café" },
  { encoding: "big5", prefix: '<!doctype html><html><head><meta CHARSET="big5"></head>\n', text: "中文" },
  { encoding: "gb2312", prefix: "<html><head><meta content='text/html; charset=gb2312' http-equiv='Content-Type'></head>\n", text: "中文" },
  { encoding: "windows-1252", prefix: '@charset "windows-1252";\n', text: "café €" },
];

async function checkBomFlow(bytes: Buffer, text: string) {
  const root = await createTempWorkspace();
  const file = join(root, "sample.txt");
  await writeFile(file, bytes);
  const registry = createToolRegistry();
  piBaseExtension(registry.pi as never);
  const execute = (name: string, args: Record<string, unknown>) => registry.getTool(name).execute("formats", { path: "sample.txt", ...args }, undefined, undefined, { cwd: root });
  const read = await execute("read", {});
  expect(read.isError).not.toBe(true);
  expect(decodeTextFile(bytes)?.text).toBe(text);
  expect(getText(read)).toContain("state=old");
  const edited = text.replace("state=old", "state=编辑");
  const edit = await execute("edit", { edits: [{ old_string: "state=old", new_string: "state=编辑" }] });
  return { file, execute, edit, edited };
}

describe("common text encoding formats", () => {
  it.each([
    { encoding: "utf-8", bom: [0xef, 0xbb, 0xbf] },
    { encoding: "utf-16le", bom: [0xff, 0xfe] },
    { encoding: "utf-16be", bom: [0xfe, 0xff] },
    { encoding: "utf-32le", bom: [0xff, 0xfe, 0x00, 0x00] },
    { encoding: "utf-32be", bom: [0x00, 0x00, 0xfe, 0xff] },
  ])("preserves $encoding BOM, mixed line endings and non-ASCII edits", async ({ encoding, bom }) => {
    // Intent: every supported BOM must survive read/edit/write with exact expected bytes.
    const family = encoding.startsWith("utf-16") ? "utf-16" : encoding.startsWith("utf-32") ? "utf-32" : "utf-8";
    const text = `<?xml version="1.0" encoding="${family}"?>\r\n中文 日本語\r\nstate=old\nunchanged\r\n`;
    const encode = (value: string) => Buffer.concat([Buffer.from(bom), iconv.encode(value, encoding)]);
    const flow = await checkBomFlow(encode(text), text);
    expect(flow.edit.isError).not.toBe(true);
    expect(await readFile(flow.file)).toEqual(encode(flow.edited));
    const write = await flow.execute("write", { content: flow.edited.replace("unchanged", "done") });
    expect(write.isError).not.toBe(true);
    expect(await readFile(flow.file)).toEqual(encode(flow.edited.replace("unchanged", "done")));
  });

  it.each(declared)("honors the $encoding file header: $prefix", async ({ encoding, prefix, text }) => {
    // Intent: explicit headers resolve short ambiguous samples without new tool arguments.
    const content = `${prefix}${text}\r\nstate=old\n`;
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as never);
    const execute = (name: string, args: Record<string, unknown>) => registry.getTool(name).execute("declared", { path: "sample.txt", ...args }, undefined, undefined, { cwd: root });
    const created = await execute("write", { content });
    expect(created.isError).not.toBe(true);
    expect(await readFile(join(root, "sample.txt"))).toEqual(iconv.encode(content, encoding));
    const read = await execute("read", {});
    expect(getText(read)).toContain(text);
    const edit = await execute("edit", { edits: [
      { old_string: "state=old", new_string: "state=new" },
      { old_string: text, new_string: `${text}${text}` },
    ] });
    expect(edit.isError).not.toBe(true);
    expect(await readFile(join(root, "sample.txt"))).toEqual(iconv.encode(content.replace("state=old", "state=new").replace(text, `${text}${text}`), encoding));
    const write = await execute("write", { content: content.replace("state=old", "state=done") });
    expect(write.isError).not.toBe(true);
    expect(await readFile(join(root, "sample.txt"))).toEqual(iconv.encode(content.replace("state=old", "state=done"), encoding));
  });

  it("keeps a changed declaration consistent with bytes rather than merely relabeling them", async () => {
    // Intent: changing a header alone cannot silently reinterpret the remaining non-ASCII bytes.
    const root = await createTempWorkspace();
    const file = join(root, "sample.txt");
    const before = '# coding: big5\n中文\n';
    await writeFile(file, iconv.encode(before, "big5"));
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as never);
    const edit = await registry.getTool("edit").execute("header", { path: "sample.txt", edits: [{ old_string: "coding: big5", new_string: "coding: utf-8" }] }, undefined, undefined, { cwd: root });
    expect(edit.isError).toBe(true);
    expect(await readFile(file)).toEqual(iconv.encode(before, "big5"));
    const content = before.replace("big5", "utf-8");
    const write = await registry.getTool("write").execute("convert", { path: "sample.txt", content }, undefined, undefined, { cwd: root });
    expect(write.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(Buffer.from(content, "utf8"));
  });

  it.each(["edit", "write"])("honors an explicit ASCII declaration during %s", async (name) => {
    // Intent: detector-reported ASCII may default to UTF-8, but a declared ASCII file must remain ASCII.
    const root = await createTempWorkspace();
    const file = join(root, "sample.txt");
    const content = '# coding: ASCII\nstate=old\n';
    const original = Buffer.from(content, "ascii");
    await writeFile(file, original);
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as never);
    const args = name === "edit"
      ? { edits: [{ old_string: "state=old", new_string: "state=中文" }] }
      : { content: content.replace("old", "中文") };
    const result = await registry.getTool(name).execute("ascii", { path: "sample.txt", ...args }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("cannot be represented");
    expect(await readFile(file)).toEqual(original);
  });

  it("does not silently guess when a standard header declares an unsupported encoding", () => {
    // Intent: an explicit but unsupported declaration is not a license to decode it as UTF-8.
    expect(() => detectDeclaredTextEncoding('# coding: x-unknown\n')).toThrow(/Unsupported declared/);
  });

  it.each([
    ['const xml = \'<?xml encoding="GBK"?>\';\n', undefined],
    ['const meta = \'<meta charset="big5">\';\n', undefined],
    ['<html><head><!-- <meta charset="big5"> --><meta charset="utf-8"></head>', "utf-8"],
    ['<html><head><script>const s = \'<meta charset="big5">\';</script></head>', undefined],
    ['<html><head></head><body><meta charset="big5"></body>', undefined],
    ['print("x")\n# coding: gbk\n', undefined],
  ])("does not interpret source strings or non-header declarations: %s", (text, expected) => {
    // Intent: honoring headers must not reinterpret ordinary UTF-8 source files.
    expect(detectDeclaredTextEncoding(text!)).toBe(expected);
  });
});
