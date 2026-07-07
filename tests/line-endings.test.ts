import { describe, expect, it } from "vitest";
import {
  detectLineEnding,
  formatLineEndingStyle,
  normalizeToLF,
  parseLineEndingDocument,
  serializeLineEndingDocument,
  serializeNormalizedDocument,
} from "../src/line-endings.js";

describe("line endings", () => {
  it("classifies and labels each concrete ending style plus mixed content", () => {
    // Intent: detection and labeling drive how read reports and edit preserves EOLs,
    // so every style (crlf/cr/lf/mixed) must be recognized and named consistently.
    expect(detectLineEnding("a\r\nb")).toBe("\r\n");
    expect(detectLineEnding("a\rb")).toBe("\r");
    expect(detectLineEnding("a\nb")).toBe("\n");
    expect(detectLineEnding("a\r\nb\rc\nd")).toBe("mixed");
    expect(formatLineEndingStyle("\r\n")).toBe("crlf");
    expect(formatLineEndingStyle("\r")).toBe("cr");
    expect(formatLineEndingStyle("\n")).toBe("lf");
    expect(formatLineEndingStyle("mixed")).toBe("mixed");
  });

  it("normalizes all endings to LF and serializes a normalized document", () => {
    // Intent: the model always sees an LF-normalized view; normalization and
    // normalized serialization must collapse CRLF/CR to LF while keeping structure.
    expect(normalizeToLF("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    const document = parseLineEndingDocument("a\r\nb\rc");
    expect(serializeNormalizedDocument(document)).toBe("a\nb\nc");
  });

  it("rejects inconsistent documents during serialization", () => {
    // Intent: serialization assumes lines and eolAfter stay aligned; a mismatch is a
    // programming error that must fail loudly rather than emit corrupted content.
    const broken = { lines: ["a", "b"], eolAfter: ["\n" as const] };
    expect(() => serializeLineEndingDocument(broken)).toThrow(/inconsistent/);
    expect(() => serializeNormalizedDocument(broken)).toThrow(/inconsistent/);
  });

  it("parses and serializes mixed line endings without losing structure", () => {
    const content = "alpha\r\nbeta\ngamma\rdelta\n";
    const document = parseLineEndingDocument(content);
    expect(document.lines).toEqual(["alpha", "beta", "gamma", "delta", ""]);
    expect(document.eolAfter).toEqual(["\r\n", "\n", "\r", "\n", null]);
    expect(document.defaultEnding).toBe("\r\n");
    expect(serializeLineEndingDocument(document)).toBe(content);
  });

  it("defaults to LF when a file has no separators", () => {
    const document = parseLineEndingDocument("solo");
    expect(document.lines).toEqual(["solo"]);
    expect(document.eolAfter).toEqual([null]);
    expect(document.defaultEnding).toBe("\n");
    expect(serializeLineEndingDocument(document)).toBe("solo");
  });

  it("preserves an empty trailing line when the file ends with a newline", () => {
    const document = parseLineEndingDocument("alpha\nbeta\n");
    expect(document.lines).toEqual(["alpha", "beta", ""]);
    expect(document.eolAfter).toEqual(["\n", "\n", null]);
    expect(serializeLineEndingDocument(document)).toBe("alpha\nbeta\n");
  });
});
