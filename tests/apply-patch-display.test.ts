import { describe, expect, it } from "vitest";
import { parseApplyPatch } from "../src/apply-patch-core.js";
import {
  applyPatchOperationLabel,
  buildApplyPatchPreview,
  buildRawApplyPatchPreview,
  formatApplyPatchPreview,
} from "../src/apply-patch-display.js";

function patch(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

describe("apply_patch display", () => {
  it("renders every operation, move destination, context, and EOF marker", () => {
    // Intent: call and permission views must share a complete, operation-aware preview model.
    const parsed = parseApplyPatch(patch(
      "*** Add File: empty.txt",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "@@ section",
      " unchanged",
      "-old",
      "+new",
      "*** End of File",
      "*** Delete File: obsolete.txt",
    ));

    expect(formatApplyPatchPreview(buildApplyPatchPreview(parsed))).toBe([
      "A empty.txt",
      "(empty file)",
      "",
      "M old.txt -> new.txt",
      "@@ section",
      " unchanged",
      "-old",
      "+new",
      "*** End of File",
      "",
      "D obsolete.txt",
      "(delete file)",
    ].join("\n"));
    expect(applyPatchOperationLabel("add")).toBe("A");
    expect(applyPatchOperationLabel("update")).toBe("M");
    expect(applyPatchOperationLabel("delete")).toBe("D");
  });

  it("bounds total lines and individual long lines", () => {
    // Intent: large or pathological patch text must not flood call cards or approval dialogs.
    const parsed = parseApplyPatch(patch(
      "*** Add File: large.txt",
      `+${"x".repeat(300)}`,
      "+second",
      "+third",
    ));
    const lineBounded = buildApplyPatchPreview(parsed, { maxLines: 3, maxLineChars: 40 });
    const rendered = formatApplyPatchPreview(lineBounded);

    expect(lineBounded.omittedLines).toBe(2);
    expect(rendered).toContain("A large.txt");
    expect(rendered).toContain(`${"x".repeat(36)}...`);
    expect(rendered).toContain("... (2 more patch lines)");
    expect(rendered).not.toContain("+third");

    const tinyLines = buildApplyPatchPreview(parsed, { maxLines: Number.POSITIVE_INFINITY, maxLineChars: 2 });
    expect(tinyLines.lines.every((line) => line.text.length <= 2)).toBe(true);
    const hidden = buildApplyPatchPreview(parsed, { maxLines: 0 });
    expect(hidden.lines).toEqual([]);
    expect(hidden.omittedLines).toBe(4);
  });

  it("collapses only Add body lines when requested", () => {
    // Intent: settled call cards should bound whole-file additions without hiding Update or Delete review data.
    const parsed = parseApplyPatch(patch(
      "*** Add File: created.txt",
      ...Array.from({ length: 12 }, (_, index) => `+created-${index + 1}`),
      "*** Update File: updated.txt",
      "@@",
      ...Array.from({ length: 12 }, (_, index) => `+updated-${index + 1}`),
      "*** Delete File: removed.txt",
    ));

    const rendered = formatApplyPatchPreview(buildApplyPatchPreview(parsed, { maxAddLines: 10 }));

    expect(rendered).toContain("+created-10");
    expect(rendered).not.toContain("+created-11");
    expect(rendered).toContain("... (2 more lines, 12 total)");
    expect(rendered).toContain("+updated-12");
    expect(rendered).toContain("D removed.txt");
    expect(rendered).toContain("(delete file)");
  });

  it("bounds only displayed Add lines by character count when requested", () => {
    // Intent: a generated file can contain a pathological single line, but Update/Delete review
    // data must remain complete when the settled Add-only preview is compacted.
    const longAdd = "a".repeat(1_700);
    const longUpdate = "u".repeat(1_700);
    const parsed = parseApplyPatch(patch(
      "*** Add File: generated.txt",
      `+${longAdd}`,
      "*** Update File: existing.txt",
      "@@",
      `+${longUpdate}`,
    ));

    const preview = buildApplyPatchPreview(parsed, { maxAddLines: 10, maxAddLineChars: 1_500 });
    const addLine = preview.lines.find((line) => line.kind === "add" && line.text.startsWith("+a"));
    const updateLine = preview.lines.find((line) => line.kind === "add" && line.text.startsWith("+u"));

    expect(addLine?.text).toBe(`+${"a".repeat(1_496)}...`);
    expect(addLine?.text).toHaveLength(1_500);
    expect(updateLine?.text).toBe(`+${longUpdate}`);
  });

  it("bounds malformed raw text without normalizing away CRLF or CR line boundaries", () => {
    const raw = buildRawApplyPatchPreview(`first\r\n${"x".repeat(300)}\rthird\nfourth`, {
      maxLines: 3,
      maxLineChars: 20,
    });
    expect(formatApplyPatchPreview(raw)).toBe([
      "first",
      `${"x".repeat(17)}...`,
      "... (2 more patch lines)",
    ].join("\n"));
    expect(raw.omittedLines).toBe(2);
    expect(buildRawApplyPatchPreview("unchanged", { maxLineChars: Number.NaN }).lines[0]?.text).toBe("unchanged");
  });
});
