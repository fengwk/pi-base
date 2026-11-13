import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import {
  BinaryFileError,
  EncodingDeclarationConflictError,
  UndecodableTextError,
  UnknownTextEncodingError,
  UnrepresentableTextError,
  UnsupportedEncodingLabelError,
  type TextEncoding,
  decodeTextFile,
  encodeTextFile,
  formatTextFileError,
  resolveContentEncoding,
  resolveDeclaredEncoding,
} from "../src/text-codec.js";

function encoded(text: string, encoding: string): Buffer {
  return encoding === "utf-8" ? Buffer.from(text, "utf8") : iconv.encode(text, encoding);
}

function declaredEncoding(text: string, filePath: string): TextEncoding {
  const encoding = resolveDeclaredEncoding(text, filePath, "none");
  if (!encoding) throw new Error(`expected a declaration in ${filePath}`);
  return encoding;
}

describe("text codec", () => {
  it.each([
    { bom: [0xff, 0xfe, 0x00, 0x00], encoding: "UTF-32LE", codec: "utf-32le" },
    { bom: [0x00, 0x00, 0xfe, 0xff], encoding: "UTF-32BE", codec: "utf-32be" },
    { bom: [0xef, 0xbb, 0xbf], encoding: "UTF-8", codec: "utf-8" },
    { bom: [0xff, 0xfe], encoding: "UTF-16LE", codec: "utf-16le" },
    { bom: [0xfe, 0xff], encoding: "UTF-16BE", codec: "utf-16be" },
  ])("decodes $encoding from its byte order mark", ({ bom, encoding, codec }) => {
    // Intent: each BOM decides its own encoding, and UTF-32LE must win over the
    // UTF-16LE mark it starts with.
    const bytes = Buffer.concat([Buffer.from(bom), encoded("中文 abc\n", codec)]);
    const decoded = decodeTextFile(bytes, "sample.txt");
    expect(decoded.encoding.name).toBe(encoding);
    expect(decoded.text).toBe("中文 abc\n");
    expect(encodeTextFile(decoded.text, decoded.encoding, decoded.bom)).toEqual(bytes);
  });

  it("does not guess BOM-less UTF-16 and follows Git's NUL rule", () => {
    // Intent: no statistical UTF-16/legacy guessing; a NUL byte is binary only
    // inside the first 8000 bytes, and control characters are ordinary text.
    expect(() => decodeTextFile(Buffer.from([0x41, 0x00, 0x42, 0x00]))).toThrow(BinaryFileError);
    const lateNul = Buffer.concat([Buffer.from("a".repeat(8000), "ascii"), Buffer.from([0x00])]);
    expect(decodeTextFile(lateNul).text).toBe(`${"a".repeat(8000)}\u0000`);
    expect(decodeTextFile(Buffer.from([0x1b, 0x1b, 0x41])).text).toBe("\u001b\u001bA");
  });

  it("rejects undeclared legacy bytes instead of guessing an encoding", () => {
    // Intent: a wrong guess rewrites the file in the wrong encoding, so only a
    // declaration may select a non-UTF-8 codec.
    expect(() => decodeTextFile(encoded("这是一个中文文件。\n", "gbk"), "sample.txt")).toThrow(UnknownTextEncodingError);
    expect(() => decodeTextFile(encoded("中文\n", "big5"), "sample.txt")).toThrow(UnknownTextEncodingError);
  });

  it.each([
    { form: "XML declaration", filePath: "sample.xml", prefix: '<?xml version="1.0" encoding="GBK"?>\n', encoding: "gbk", name: "GBK", text: "中文 café" },
    { form: "CSS @charset", filePath: "sample.css", prefix: '@charset "windows-1252";\n', encoding: "windows-1252", name: "windows-1252", text: "café €" },
    { form: "HTML meta charset", filePath: "sample.html", prefix: '<!doctype html><html><head><meta charset="big5"></head>\n', encoding: "big5", name: "Big5", text: "中文" },
    { form: "HTML http-equiv", filePath: "sample.htm", prefix: '<html><head><meta content="text/html; charset=gb2312" http-equiv="Content-Type"></head>\n', encoding: "gbk", name: "GBK", text: "中文" },
    { form: "Python line 1", filePath: "sample.py", prefix: "# -*- coding: big5 -*-\n", encoding: "big5", name: "Big5", text: "中文" },
    { form: "Python line 2", filePath: "sample.pyw", prefix: "#!/usr/bin/env python\n# coding: shift_jis\n", encoding: "shift_jis", name: "Shift_JIS", text: "テスト" },
    { form: "Python fileencoding", filePath: "sample.pyi", prefix: "# fileencoding=gbk\n", encoding: "gbk", name: "GBK", text: "中文" },
    { form: "Ruby line 2", filePath: "sample.rb", prefix: "#!/usr/bin/env ruby\n# encoding: euc-kr\n", encoding: "euc-kr", name: "EUC-KR", text: "한국어" },
    { form: "JSP pageEncoding", filePath: "sample.jsp", prefix: '<%@ page pageEncoding="gbk" %>\n', encoding: "gbk", name: "GBK", text: "中文" },
    { form: "JSP contentType charset", filePath: "sample.tag", prefix: '<%@ page contentType="text/html; charset=big5" %>\n', encoding: "big5", name: "Big5", text: "中文" },
  ])("honors the $form declaration", ({ filePath, prefix, encoding, name, text }) => {
    // Intent: every supported declaration form selects its encoding, and the
    // canonical name is reported whatever label the file used.
    const content = `${prefix}${text}\nstate=old\n`;
    const bytes = encoded(content, encoding);
    const decoded = decodeTextFile(bytes, filePath);
    expect(decoded.encoding.name).toBe(name);
    expect(decoded.text).toBe(content);
    expect(encodeTextFile(decoded.text, decoded.encoding, decoded.bom)).toEqual(bytes);
  });

  it.each([
    { why: "a Markdown note", filePath: "notes.md", text: "# Notes on coding: style\n" },
    { why: "a text note", filePath: "notes.txt", text: "# coding: gbk\n" },
    { why: "a shell script", filePath: "script.sh", text: "# coding: gbk\n" },
    { why: "a coding comment on line 3", filePath: "sample.py", text: "print('x')\n\n# coding: gbk\n" },
    { why: "a JS string", filePath: "sample.ts", text: 'const xml = \'<?xml encoding="GBK"?>\';\n' },
    { why: "an HTML comment", filePath: "sample.html", text: '<html><head><!-- <meta charset="big5"> --></head>' },
    { why: "an HTML comment before a real declaration", filePath: "sample.html", text: '<html><head><!-- <meta charset="big5"> --><meta charset="gbk"></head>', expected: "GBK" },
    { why: "an HTML script body", filePath: "sample.html", text: "<html><head><script>const s = '<meta charset=\"big5\">';</script></head>" },
    { why: "an HTML body meta", filePath: "sample.html", text: '<html><head></head><body><meta charset="big5"></body>' },
    { why: "a @charset after the first byte", filePath: "sample.css", text: "/* x */\n@charset \"big5\";\n" },
    { why: "an XML declaration after the first byte", filePath: "sample.xml", text: '\n<?xml version="1.0" encoding="GBK"?>' },
  ])("ignores declaration-like text in $why", ({ filePath, text, expected }) => {
    // Intent: only a standard declaration in its defined position may choose the
    // codec; similar text elsewhere must not reinterpret ordinary UTF-8 files.
    const name = resolveDeclaredEncoding(text, filePath, "none")?.name;
    expect(name).toBe(expected);
    expect(decodeTextFile(Buffer.from(text, "utf8"), filePath).encoding.name).toBe(name ?? "UTF-8");
  });

  it("normalizes Python and Ruby coding labels like CPython", () => {
    // Intent: PEP 263 accepts suffixed labels such as `utf-8-unix`, and its
    // latin-1 aliases must stay true Latin-1 rather than WHATWG windows-1252.
    expect(declaredEncoding("# -*- coding: utf-8-unix -*-\n", "a.py").name).toBe("UTF-8");
    expect(declaredEncoding("# coding: utf8\n", "a.py").name).toBe("UTF-8");
    expect(declaredEncoding("# coding: latin-1\n", "a.py").name).toBe("ISO-8859-1");
    expect(declaredEncoding("#!/usr/bin/env ruby\n# coding: iso-8859-1-unix\n", "a.rb").name).toBe("ISO-8859-1");
    // CSS follows the Encoding Standard, where these labels mean windows-1252.
    expect(declaredEncoding('@charset "iso-8859-1";\n', "a.css").name).toBe("windows-1252");
    expect(declaredEncoding('@charset "gb2312";\n', "a.css").name).toBe("GBK");
  });

  it("reports unsupported labels, conflicts and undecodable bytes distinctly", () => {
    // Intent: an explicit but unusable declaration must fail loudly instead of
    // falling back to UTF-8, and a declaration must agree with the bytes.
    expect(() => declaredEncoding("# coding: x-unknown\n", "a.py")).toThrow(UnsupportedEncodingLabelError);
    expect(() => decodeTextFile(Buffer.from('# coding: x-unknown\n', "utf8"), "a.py")).toThrow(/Unsupported declared text encoding "x-unknown"/);
    // Valid UTF-8 Chinese under a legacy declaration can only be a misinterpretation.
    expect(() => decodeTextFile(Buffer.from('<html><head><meta charset="gb2312"></head>\n中文\n', "utf8"), "a.html"))
      .toThrow(EncodingDeclarationConflictError);
    // ASCII declarations restrict the bytes they describe.
    expect(() => decodeTextFile(Buffer.from("# coding: ascii\ncaf\u00e9\n", "utf8"), "a.py")).toThrow(UndecodableTextError);
    // Bytes that do not round-trip through the declared codec are refused.
    expect(() => decodeTextFile(Buffer.concat([Buffer.from("# coding: gbk\n", "ascii"), Buffer.from([0xff])]), "a.py"))
      .toThrow(UndecodableTextError);
    // A UTF-8 declaration on invalid UTF-8 is undecodable, not a legacy file.
    expect(() => decodeTextFile(Buffer.concat([Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n'), Buffer.from([0xff])]), "a.xml"))
      .toThrow(UndecodableTextError);
    // A generic UTF-16 label needs a byte order mark to resolve the byte order.
    expect(() => decodeTextFile(Buffer.from('# coding: utf-16\n', "utf8"), "a.py")).toThrow(EncodingDeclarationConflictError);
  });

  it("encodes with the canonical name and refuses unrepresentable text", () => {
    // Intent: write/edit must fail with the offending character, code point and
    // line instead of writing replacement bytes.
    const latin1 = declaredEncoding("# coding: latin-1\n", "a.py");
    const error = (() => {
      try {
        encodeTextFile("ok\n中\n", latin1, "none");
        return undefined;
      } catch (caught) {
        return caught as Error;
      }
    })();
    expect(error).toBeInstanceOf(UnrepresentableTextError);
    expect(error?.message).toBe('The new text cannot be encoded in ISO-8859-1: "中" (U+4E2D) on line 2.');
    // A leading U+FEFF asks for a byte order mark; it is never encoded as content.
    expect(encodeTextFile("\uFEFFhello", latin1, "none")).toEqual(Buffer.from("hello", "latin1"));
  });

  it("resolves whole-file rewrite encodings from the content itself", () => {
    // Intent: write keeps a BOM the content asks for and refuses a BOM request
    // that the declared encoding cannot represent.
    expect(resolveContentEncoding("plain\n", "a.txt")).toMatchObject({ encoding: { name: "UTF-8" }, bom: "none" });
    expect(resolveContentEncoding("\uFEFFplain\n", "a.txt")).toMatchObject({ encoding: { name: "UTF-8" }, bom: "utf-8" });
    expect(resolveContentEncoding('\uFEFF<?xml version="1.0" encoding="UTF-16"?>\n', "a.xml")).toMatchObject({
      encoding: { name: "UTF-16LE" },
      bom: "utf-16le",
    });
    expect(() => resolveContentEncoding('<?xml version="1.0" encoding="UTF-16LE"?>\n', "a.xml")).toThrow(EncodingDeclarationConflictError);
    expect(() => resolveContentEncoding("\uFEFF# coding: gbk\n", "a.py")).toThrow(/byte order mark/);
  });

  it("describes undecodable files for the tools that reject them", () => {
    // Intent: the same codec failure reads as one actionable sentence per tool.
    const unknown = new UnknownTextEncodingError();
    expect(formatTextFileError(unknown, "src/data.txt", "read"))
      .toContain("src/data.txt is not UTF-8 text and declares no encoding, so it was not read.");
    expect(formatTextFileError(unknown, "src/data.txt", "searched"))
      .toContain("so it was not searched.");
    expect(formatTextFileError(new BinaryFileError(), "bin.dat", "read"))
      .toBe("bin.dat is a binary file (it contains NUL bytes).");
  });
});
