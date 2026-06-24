import { describe, expect, it } from "vitest";
import { parseLineEndingDocument, serializeLineEndingDocument } from "../src/line-endings.js";

describe("line endings", () => {
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
