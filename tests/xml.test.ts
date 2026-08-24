import { describe, expect, it } from "vitest";
import { escapeXml, unescapeXml } from "../src/xml.js";

describe("xml helpers", () => {
  it("round-trips escaped task envelope values", () => {
    // Intent: persisted task envelopes must recover their original text for UI rendering without
    // weakening the escaping used when the envelope is first constructed.
    const value = `<task id="a&b">'quoted'</task>`;
    expect(unescapeXml(escapeXml(value))).toBe(value);
  });

  it("decodes exactly one entity layer", () => {
    // Intent: a child-controlled literal entity must not be recursively decoded into markup.
    expect(unescapeXml("&amp;lt;task&amp;gt;")).toBe("&lt;task&gt;");
  });
});
