import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import { looksLikeBinary, looksLikeDecodedBinaryText } from "../src/binary-detect.js";
import {
  bomKindForEncoding,
  decodeTextFile,
  defaultTextEncoding,
  detectTextFileEncoding,
  encodeTextFile,
  textStartsWithBomMarker,
} from "../src/text-codec.js";

describe("text codec", () => {
  it("distinguishes true binary data from valid replacement-character text", () => {
    // Intent: UTF-8 text may legitimately contain U+FFFD; only decoder-created
    // replacement bytes should make read/edit/grep reject a file as binary.
    expect(looksLikeBinary(Buffer.alloc(0))).toBe(false);
    expect(looksLikeBinary(Buffer.from([0x00, 0x41]))).toBe(true);
    expect(looksLikeBinary(Buffer.from("\uFFFD", "utf8"))).toBe(false);
    expect(looksLikeBinary(Buffer.from([0xff]))).toBe(true);
  });

  it("treats common whitespace as text while still detecting dense controls", () => {
    // Intent: terminal logs contain tabs/newlines, but dense control characters
    // are still a strong signal that decoded text is not useful source text.
    expect(looksLikeDecodedBinaryText("")).toBe(false);
    expect(looksLikeDecodedBinaryText("alpha\tbeta\n")).toBe(false);
    expect(looksLikeDecodedBinaryText("\u001b".repeat(20) + "text")).toBe(true);
    expect(looksLikeDecodedBinaryText("\uFFFD".repeat(10))).toBe(true);
  });

  it("detects BOMs and UTF-16 without a BOM", () => {
    // Intent: read/edit/write must preserve legacy text metadata, not silently
    // reinterpret UTF-16 files as binary or plain UTF-8.
    expect(detectTextFileEncoding(Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode("A", "utf-16be")]))).toMatchObject({
      encoding: "utf-16be",
      bom: "utf-16be",
      source: "bom",
    });
    expect(detectTextFileEncoding(Buffer.from([0x41, 0x00, 0x42, 0x00]))).toMatchObject({
      encoding: "utf-16le",
      bom: "none",
      source: "utf16-heuristic",
    });
  });

  it("decodes legacy encoded text instead of classifying it as binary", () => {
    // Intent: the original review found non-UTF-8 text risk; GBK content should
    // stay readable for agents rather than being blocked by binary detection.
    const source = "这是一个中文文件，用于测试旧编码识别。\n第二行内容。\n";
    const bytes = iconv.encode(source, "gbk");
    const decoded = decodeTextFile(bytes);
    expect(decoded).not.toBeNull();
    expect(decoded?.text).toBe(source);
    expect(decoded?.encoding).not.toBe(defaultTextEncoding());
  });

  it("falls back to UTF-8 for suspicious decoded text that is not binary bytes", () => {
    // Intent: if the detector cannot identify an encoding and the bytes are
    // still valid text, callers should get a conservative UTF-8 view.
    const bytes = Buffer.from([0x1b, 0x1b, 0x1b, 0x1b, 0x1b, 0x41]);
    const decoded = decodeTextFile(bytes);
    expect(decoded).toEqual({
      encoding: "utf-8",
      bom: "none",
      source: "default",
      text: "\u001b\u001b\u001b\u001b\u001bA",
    });
  });

  it("maps encodings to BOM kinds and validates lossy writes", () => {
    // Intent: write/edit use this mapping to preserve BOM metadata and must not
    // write characters that cannot round-trip in the target encoding.
    expect(bomKindForEncoding("ASCII")).toBe("utf-8");
    expect(bomKindForEncoding("utf-16le")).toBe("utf-16le");
    expect(bomKindForEncoding("UTF-16BE")).toBe("utf-16be");
    expect(bomKindForEncoding("utf-32le")).toBe("utf-32le");
    expect(bomKindForEncoding("utf-32be")).toBe("utf-32be");
    expect(bomKindForEncoding("x-unknown")).toBe("none");

    expect(textStartsWithBomMarker("\uFEFFhello")).toBe(true);
    expect(encodeTextFile("\uFEFFhello", "utf-8", "utf-8").subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(() => encodeTextFile("中文", "latin1", "none")).toThrow(/without data loss/);
  });
});
