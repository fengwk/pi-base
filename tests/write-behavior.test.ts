import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerWriteTool } from "../src/write.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

function render(component: any): string {
  return component.render(200).join("\n");
}

describe("write behavior", () => {
  it("renders full multi-line write call previews with explicit workdir", () => {
    const registry = createToolRegistry();
    registerWriteTool(registry.pi as any);
    const rendered = render(registry.getTool("write").renderCall(
      { path: "src/example.ts", workdir: "services/api", content: "alpha\nbeta\n" },
      {} as any,
      { lastComponent: undefined },
    ));

    expect(rendered).toContain("write src/example.ts in services/api");
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("beta");
  });

  it("requires path and defaults workdir during execution", async () => {
    const registry = createToolRegistry();
    registerWriteTool(registry.pi as any);

    const missingPath = await registry.getTool("write").execute("1", { content: "x" }, undefined, undefined, { cwd: process.cwd() });
    expect(missingPath.isError).toBe(true);
    expect(getText(missingPath)).toContain("path is required");

    const root = await createTempWorkspace();
    const created = await registry.getTool("write").execute("2", { path: "x.ts", content: "x" }, undefined, undefined, { cwd: root });
    expect(created.isError).not.toBe(true);
    expect(await readFile(join(root, "x.ts"), "utf8")).toBe("x");
  });

  it("writes caller-provided line endings when overwriting an existing file", async () => {
    // Intent: whole-file write follows the supplied content while still preserving the existing
    // encoding/BOM; unlike edit, it does not silently restore the previous newline style.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "existing.txt", "old\r\ntext\r\n");
    const registry = createToolRegistry();
    registerWriteTool(registry.pi as any);

    const result = await registry.getTool("write").execute(
      "1",
      { path: "existing.txt", content: "new\ntext\n" },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("new\ntext\n");
  });

  it("calls onSuccessfulWrite hook and reports overwrites", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/existing.ts", "old\n");
    const writes: string[] = [];
    const registry = createToolRegistry();
    registerWriteTool(registry.pi as any, {
      onSuccessfulWrite: (absolutePath) => writes.push(absolutePath),
    });

    const result = await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/existing.ts", content: "new\ncontent\n" },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(getText(result)).toContain("Overwrote src/existing.ts successfully.");
    expect(writes[0]).toContain("src/existing.ts");
  });

  describe("formatWriteCall collapsed preview", () => {
    const path = "../src/write-core.js";
    let formatWriteCall: (args: any, theme: any, cwd?: string, options?: { collapsed?: boolean }) => string;
    let WRITE_COLLAPSED_CALL_PREVIEW_LINES: number;

    beforeAll(async () => {
      const mod = await import(path);
      formatWriteCall = mod.formatWriteCall;
      WRITE_COLLAPSED_CALL_PREVIEW_LINES = mod.WRITE_COLLAPSED_CALL_PREVIEW_LINES;
    });

    function makeTheme() {
      return {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
        bold: (text: string) => `*${text}*`,
      } as any;
    }

    it("exports the collapsed preview line cap as 7 to match the streaming window's body tail", () => {
      expect(WRITE_COLLAPSED_CALL_PREVIEW_LINES).toBe(7);
    });

    it("renders the header alone when content is empty (no body, no hint)", () => {
      const rendered = formatWriteCall({ path: "a.ts", content: "" }, makeTheme(), "/tmp");
      expect(rendered).toContain("write");
      expect(rendered).toContain("a.ts");
      // No body block (header is "write a.ts" with no trailing "\n\n" then content).
      expect(rendered).not.toMatch(/a\.ts\s*\n\s*\n/);
    });

    it("renders the full body in un-collapsed mode regardless of length", () => {
      const content = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join("\n");
      const rendered = formatWriteCall({ path: "a.ts", content }, makeTheme(), "/tmp");
      // Un-collapsed default: every line present, no "more lines" hint.
      expect(rendered).toContain("line-1");
      expect(rendered).toContain("line-50");
      expect(rendered).not.toContain("more lines");
    });

    it("collapses long content to the first 7 lines plus a count hint", () => {
      const content = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n");
      const rendered = formatWriteCall({ path: "a.ts", content }, makeTheme(), "/tmp", { collapsed: true });
      expect(rendered).toContain("line-1");
      expect(rendered).toContain("line-7");
      expect(rendered).not.toContain("line-8");
      expect(rendered).toContain("13 more lines");
      expect(rendered).toContain("20 total");
    });

    it("collapses to all lines when content fits within the cap (no hint emitted)", () => {
      const content = "alpha\nbeta\ngamma";
      const rendered = formatWriteCall({ path: "a.ts", content }, makeTheme(), "/tmp", { collapsed: true });
      expect(rendered).toContain("alpha");
      expect(rendered).toContain("beta");
      expect(rendered).toContain("gamma");
      expect(rendered).not.toContain("more lines");
    });

    it("uses the singular 'line' when exactly one line is elided", () => {
      const content = Array.from({ length: 8 }, (_, i) => `line-${i + 1}`).join("\n");
      const rendered = formatWriteCall({ path: "a.ts", content }, makeTheme(), "/tmp", { collapsed: true });
      expect(rendered).toContain("1 more line,");
      expect(rendered).not.toContain("1 more lines,");
      expect(rendered).toContain("8 total");
    });

    it("handles the 7-line boundary (cap equals content) with no elision", () => {
      const content = Array.from({ length: 7 }, (_, i) => `line-${i + 1}`).join("\n");
      const rendered = formatWriteCall({ path: "a.ts", content }, makeTheme(), "/tmp", { collapsed: true });
      expect(rendered).toContain("line-1");
      expect(rendered).toContain("line-7");
      expect(rendered).not.toContain("more lines");
    });

    it("handles the 8-line boundary (cap plus one) with the singular elision hint", () => {
      const content = Array.from({ length: 8 }, (_, i) => `line-${i + 1}`).join("\n");
      const rendered = formatWriteCall({ path: "a.ts", content }, makeTheme(), "/tmp", { collapsed: true });
      expect(rendered).toContain("line-7");
      expect(rendered).not.toContain("line-8");
      expect(rendered).toContain("1 more line,");
    });

    it("drops a trailing newline from the content so it does not inflate the line count", () => {
      const content = "alpha\nbeta\ngamma\n";
      const rendered = formatWriteCall({ path: "a.ts", content }, makeTheme(), "/tmp", { collapsed: true });
      // Trailing newline should not produce a phantom 4th line.
      expect(rendered).toContain("alpha");
      expect(rendered).toContain("beta");
      expect(rendered).toContain("gamma");
      expect(rendered).not.toContain("more lines");
    });

    it("collapses long single-line content down to the cap (preserves the 7 visible lines)", () => {
      const content = "x".repeat(500);
      const lines = content.split("\n");
      expect(lines.length).toBe(1);
      // 1 line of content, ≤ 7, so the collapsed preview is just that one line.
      const rendered = formatWriteCall({ path: "a.ts", content }, makeTheme(), "/tmp", { collapsed: true });
      expect(rendered).toContain("xxxxx");
      expect(rendered).not.toContain("more lines");
    });

    it("omits the path segment when path is missing (no crash, just the title)", () => {
      const rendered = formatWriteCall({ content: "alpha\nbeta" }, makeTheme(), "/tmp", { collapsed: true });
      expect(rendered).toContain("write");
      expect(rendered).toContain("alpha");
      expect(rendered).not.toContain("more lines");
    });
  });
});
