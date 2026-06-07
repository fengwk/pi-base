import { describe, expect, it } from "vitest";
import { renderRawResult, resolveToolPatternValue } from "../src/render.js";

function render(component: any): string {
  return component.render(200).join("\n");
}

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};

describe("render helpers", () => {
  it("collapses long results until expanded", () => {
    const raw = Array.from({ length: 25 }, (_, index) => `line-${index + 1}`).join("\n");

    const collapsed = render(renderRawResult({ content: [{ type: "text", text: raw }] }, { expanded: false }, {}, { lastComponent: undefined }));
    expect(collapsed).not.toContain("--- result ---");
    expect(collapsed).toContain("line-20");
    expect(collapsed).not.toContain("line-21");
    expect(collapsed).toContain("ctrl+o to expand");

    const expanded = render(renderRawResult({ content: [{ type: "text", text: raw }] }, { expanded: true }, {}, { lastComponent: undefined }));
    expect(expanded).toContain("line-25");
  });

  it("does not add a leading blank line to result text", () => {
    const rendered = render(renderRawResult({ content: [{ type: "text", text: "first\nsecond" }] }, { expanded: true }, {}, { lastComponent: undefined }));
    expect(rendered.split("\n")[0]).toContain("first");
    expect(rendered.split("\n")[0]).not.toBe("");
  });

  it("supports zero-line collapsed previews", () => {
    const raw = Array.from({ length: 3 }, (_, index) => `line-${index + 1}`).join("\n");

    const collapsed = render(renderRawResult({ content: [{ type: "text", text: raw }] }, { expanded: false, collapsedLines: 0 }, {}, { lastComponent: undefined }));
    expect(collapsed).not.toContain("line-1");
    expect(collapsed).not.toContain("line-3");
    expect(collapsed).toContain("3 more lines");
    expect(collapsed).toContain("ctrl+o to expand");
  });

  it("does not add a leading blank line to collapsed result text", () => {
    const raw = Array.from({ length: 3 }, (_, index) => `line-${index + 1}`).join("\n");
    const rendered = render(renderRawResult({ content: [{ type: "text", text: raw }] }, { expanded: false, collapsedLines: 0 }, {}, { lastComponent: undefined }));
    expect(rendered.split("\n")[0]).toContain("3 more lines");
    expect(rendered.split("\n")[0]).not.toBe("");
  });

  it("colorizes structured results and diff sections", () => {
    const raw = [
      "path: /tmp/demo.txt",
      "status: ok",
      "updatedAnchors:",
      " 1#abcd|hello",
      "diff:",
      "- 1 old line",
      "+ 1 new line",
      "  2 unchanged line",
    ].join("\n");

    const rendered = render(renderRawResult({ content: [{ type: "text", text: raw }] }, { expanded: true }, theme, { lastComponent: undefined }));
    expect(rendered).toContain("<muted>path:</muted> <accent>/tmp/demo.txt</accent>");
    expect(rendered).toContain("<muted>status:</muted> <success>ok</success>");
    expect(rendered).toContain("<toolTitle><b>updatedAnchors:</b></toolTitle>");
    expect(rendered).toContain("<muted> 1#abcd|</muted><toolOutput>hello</toolOutput>");
    expect(rendered).toContain("<toolDiffRemoved>- 1 old line</toolDiffRemoved>");
    expect(rendered).toContain("<toolDiffAdded>+ 1 new line</toolDiffAdded>");
    expect(rendered).toContain("<toolDiffContext>  2 unchanged line</toolDiffContext>");
  });

  it("colorizes natural-language write success guidance", () => {
    const raw = [
      "Created src/demo.ts.",
      "Review the written file content below. Lines prefixed with digits carry LINE#HASH anchors for follow-up edits.",
      "",
      "1#abcd|hello",
    ].join("\n");

    const rendered = render(renderRawResult({ content: [{ type: "text", text: raw }] }, { expanded: true }, theme, { lastComponent: undefined }));
    expect(rendered).toContain("<success>Created src/demo.ts.</success>");
    expect(rendered).toContain("<warning>Review the written file content below. Lines prefixed with digits carry LINE#HASH anchors for follow-up edits.</warning>");
    expect(rendered).toContain("<muted>1#abcd|</muted><toolOutput>hello</toolOutput>");
  });
  it("resolves wildcard tool config patterns by specificity", () => {
    const config = {
      "*": 5,
      "lsp_*": 4,
      "*_search": 3,
      "web_*": 2,
      "web_search": 1,
    };

    expect(resolveToolPatternValue(config, "web_search")).toBe(1);
    expect(resolveToolPatternValue(config, "web_lookup")).toBe(2);
    expect(resolveToolPatternValue(config, "image_search")).toBe(3);
    expect(resolveToolPatternValue(config, "lsp_diagnostics")).toBe(4);
    expect(resolveToolPatternValue(config, "unknown_tool")).toBe(5);
  });
});
