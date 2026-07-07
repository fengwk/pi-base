import { describe, expect, it } from "vitest";
import { renderRawResult, renderStreamingCallText, resolveCollapsedResultLines, resolveToolPatternValue } from "../src/render.js";

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

  it("adds a leading blank line to separate result text from the call renderer", () => {
    const lines = renderRawResult({ content: [{ type: "text", text: "first\nsecond" }] }, { expanded: true }, {}, { lastComponent: undefined }).render(200);
    expect(lines[0]?.trim()).toBe("");
    expect(lines[1]).toContain("first");
  });

  it("supports zero-line collapsed previews", () => {
    const raw = Array.from({ length: 3 }, (_, index) => `line-${index + 1}`).join("\n");

    const collapsed = render(renderRawResult({ content: [{ type: "text", text: raw }] }, { expanded: false, collapsedLines: 0 }, {}, { lastComponent: undefined }));
    expect(collapsed).not.toContain("line-1");
    expect(collapsed).not.toContain("line-3");
    expect(collapsed).toContain("3 more lines");
    expect(collapsed).toContain("ctrl+o to expand");
  });

  it("adds a leading blank line to collapsed result text", () => {
    const raw = Array.from({ length: 3 }, (_, index) => `line-${index + 1}`).join("\n");
    const lines = renderRawResult({ content: [{ type: "text", text: raw }] }, { expanded: false, collapsedLines: 0 }, {}, { lastComponent: undefined }).render(200);
    expect(lines[0]?.trim()).toBe("");
    expect(lines[1]).toContain("3 more lines");
  });

  it("colorizes structured results and diff sections", () => {
    const raw = [
      "path: /tmp/demo.txt",
      "status: ok",
      "[src/demo.ts#A1B2]",
      "1|hello",
      "diff:",
      "-1|old line",
      "+1|new line",
      " 2|unchanged line",
    ].join("\n");

    const rendered = render(renderRawResult({ content: [{ type: "text", text: raw }] }, { expanded: true }, theme, { lastComponent: undefined }));
    expect(rendered).toContain("<muted>path:</muted> <accent>/tmp/demo.txt</accent>");
    expect(rendered).toContain("<muted>status:</muted> <success>ok</success>");
    expect(rendered).toContain("<muted>1|</muted><toolOutput>hello</toolOutput>");
    expect(rendered).toContain("<toolDiffRemoved>-1|old line</toolDiffRemoved>");
    expect(rendered).toContain("<toolDiffAdded>+1|new line</toolDiffAdded>");
    expect(rendered).toContain("<toolDiffContext> 2|unchanged line</toolDiffContext>");
  });

  it("colorizes write success message", () => {
    const raw = "Created src/demo.ts successfully.";

    const rendered = render(renderRawResult({ content: [{ type: "text", text: raw }] }, { expanded: true }, theme, { lastComponent: undefined }));
    expect(rendered).toContain("<success>Created src/demo.ts successfully.</success>");
  });
  it("colorizes status states and explicit error fields", () => {
    const raw = [
      "status: completed",
      "status: running",
      "status: failed",
      "error: invalid api key",
    ].join("\n");

    const rendered = render(renderRawResult({ content: [{ type: "text", text: raw }] }, { expanded: true }, theme, { lastComponent: undefined }));
    expect(rendered).toContain("<muted>status:</muted> <success>completed</success>");
    expect(rendered).toContain("<muted>status:</muted> <warning>running</warning>");
    expect(rendered).toContain("<muted>status:</muted> <error>failed</error>");
    expect(rendered).toContain("<muted>error:</muted> <error>invalid api key</error>");
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

  it("uses internal collapsed line defaults and falls back to wildcard", () => {
    expect(resolveCollapsedResultLines("read", undefined, undefined)).toBe(10);
    expect(resolveCollapsedResultLines("grep", undefined, undefined)).toBe(15);
    expect(resolveCollapsedResultLines("write", undefined, undefined)).toBe(10);
    expect(resolveCollapsedResultLines("bash", undefined, undefined)).toBe(20);
    expect(resolveCollapsedResultLines("find", undefined, undefined)).toBe(20);
    expect(resolveCollapsedResultLines("lsp_diagnostics", undefined, undefined)).toBe(20);
  });

  it("annotates and truncates call text while args are still streaming", () => {
    const raw = ["write <missing-path>", "", ...Array.from({ length: 15 }, (_, index) => `line-${index + 1}`)].join("\n");

    const rendered = render(renderStreamingCallText(raw, theme, {
      lastComponent: undefined,
      argsComplete: false,
      expanded: false,
    }));

    expect(rendered).toContain("write ...");
    expect(rendered).toContain("streaming args");
    expect(rendered).toContain("line-10");
    expect(rendered).not.toContain("line-15");
    expect(rendered).toContain("more lines while args are streaming");
  });

  it("leaves completed call text unchanged", () => {
    const raw = "grep <missing-pattern> in src";

    const rendered = render(renderStreamingCallText(raw, theme, {
      lastComponent: undefined,
      argsComplete: true,
      expanded: false,
    }));

    expect(rendered).toContain("<missing-pattern>");
    expect(rendered).not.toContain("streaming args");
  });
});
