import { describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

describe("grep to read continuation", () => {
  it("recovers a long Unicode match line and subsequent rows through the public result hooks", async () => {
    // The grep excerpt must reveal a deep match. Following read's next cursor
    // through the full extension must then reconstruct the source without
    // dropping its line tail, repeating text, or losing the cursor in a guard.
    const root = await createTempWorkspace();
    const longLine = `${"a".repeat(1999)}🚀${"x".repeat(500)}NEEDLE${"b".repeat(2100)}`;
    await writeWorkspaceFile(root, "large.txt", `${longLine}\ntail\n`);
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const context = { cwd: root };

    const grep = await registry.getTool("grep").execute(
      "find", { path: "large.txt", pattern: "NEEDLE" }, undefined, undefined, context,
    );
    expect(grep.isError).not.toBe(true);
    const hit = getText(grep).match(/^large\.txt:(\d+): .*NEEDLE/m);
    expect(hit).not.toBeNull();

    const params = { path: "large.txt", offset: Number(hit![1]), column_offset: 1 };
    const reconstructed = new Map<number, string>();
    let pages = 0;
    while (pages < 4) {
      const result = await registry.getTool("read").execute(
        `recover-${pages++}`, params, undefined, undefined, context,
      );
      expect(result.isError).not.toBe(true);
      const text = getText(result);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(50 * 1024);
      expect(text.split("\n").length).toBeLessThanOrEqual(2000);
      for (const row of text.split("\n")) {
        const match = row.match(/^\s*(\d+)\|(.*)$/);
        if (!match) continue;
        const line = Number(match[1]);
        reconstructed.set(line, (reconstructed.get(line) ?? "") + match[2]);
      }
      const next = result.details?.next;
      if (!next) break;
      expect(next.line > params.offset || (next.line === params.offset && next.column > params.column_offset)).toBe(true);
      params.offset = next.line;
      params.column_offset = next.column;
    }
    expect(pages).toBe(3);
    expect(reconstructed.get(1)).toBe(longLine);
    expect(reconstructed.get(2)).toBe("tail");
  });
});
