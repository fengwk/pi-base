import { describe, expect, it } from "vitest";
import { inferToolResultIsError } from "../src/tool-result.js";
import { markPiBaseToolErrorDetails } from "../src/tool-error-marker.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

describe("inferToolResultIsError", () => {
  it("honors explicit error signals regardless of tool or text", () => {
    // Intent: an explicit isError flag or a pi-base error marker is authoritative
    // and must short-circuit the text-based heuristics.
    expect(inferToolResultIsError("read", { ...textResult("ok"), isError: true })).toBe(true);
    expect(inferToolResultIsError("read", { content: [], details: markPiBaseToolErrorDetails({}) })).toBe(true);
    expect(inferToolResultIsError("read", textResult(""))).toBe(false);
  });

  it("treats bash output as an error only for genuine failure shapes", () => {
    // Intent: bash success output frequently starts with prose, so only a bare
    // Error: line or a trailing failure/timeout footer should count as an error.
    expect(inferToolResultIsError("bash", textResult("Error: command missing"))).toBe(true);
    expect(inferToolResultIsError("bash", textResult("Error: boom\n\nCommand exited with code 2"))).toBe(true);
    expect(inferToolResultIsError("bash", textResult("Error: slow\n\nCommand timed out after 2s"))).toBe(true);
    expect(inferToolResultIsError("bash", textResult("Error: context\nstill running normally"))).toBe(false);
    expect(inferToolResultIsError("bash", textResult("all good"))).toBe(false);
  });

  it("uses prefix heuristics for edit and simple Error: detection for read-like tools", () => {
    // Intent: edit surfaces several structured failure prefixes, while read/write/
    // grep/lsp tools consistently prefix hard failures with Error:.
    expect(inferToolResultIsError("edit", textResult("Could not find old_string"))).toBe(true);
    expect(inferToolResultIsError("edit", textResult("No changes were made"))).toBe(true);
    expect(inferToolResultIsError("edit", textResult("Applied 1 edit"))).toBe(false);
    expect(inferToolResultIsError("grep", textResult("Error: bad pattern"))).toBe(true);
    expect(inferToolResultIsError("lsp_diagnostics", textResult("Error: no server"))).toBe(true);
    expect(inferToolResultIsError("write", textResult("Wrote 3 lines"))).toBe(false);
    expect(inferToolResultIsError("unknown-tool", textResult("Error: anything"))).toBe(false);
  });
});
