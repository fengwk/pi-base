import iconv from "iconv-lite";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeGrep } from "../src/grep-core.js";
import { createTempWorkspace, getText } from "./helpers.js";

// A lone surrogate (high without a following low, or low without a preceding
// high) means a Unicode excerpt boundary split a surrogate pair in half.
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function matchLine(text: string, needle: string): string {
  const line = text.split("\n").find((candidate) => candidate.includes(needle));
  expect(line, `expected an output line containing ${needle}`).toBeTruthy();
  return line!;
}

describe("grep match excerpts", () => {
  it("centers a far-tail standard match in a bounded excerpt", async () => {
    // Intent: rg submatch byte offsets must drive the excerpt, so a match at
    // column 2501 of a long line stays visible instead of hiding behind the
    // first-500-chars prefix.
    const root = await createTempWorkspace();
    const content = `${"x".repeat(2500)}NEEDLE${"y".repeat(600)}\n`;
    await writeFile(join(root, "long.txt"), content, "utf8");

    const result = await executeGrep("grep-excerpt-tail", {
      workdir: ".",
      path: "long.txt",
      pattern: "NEEDLE",
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const line = matchLine(getText(result), "NEEDLE");
    // The excerpt shows the match with context on both sides, still bounded
    // well below the full 3106-char line.
    expect(line).toMatch(/x{200}NEEDLE/);
    expect(line).toMatch(/NEEDLEy{200}/);
    expect(line.length).toBeLessThan(600);
  });

  it("aligns excerpts through three-byte Chinese prefixes", async () => {
    // Intent: submatch offsets are UTF-8 byte offsets. 800 Chinese characters
    // put the match at byte 2400 but UTF-16 unit 800; treating bytes as units
    // would shift the excerpt and truncate the leading context.
    const root = await createTempWorkspace();
    const content = `${"中".repeat(800)}NEEDLE${"y".repeat(600)}\n`;
    await writeFile(join(root, "long.txt"), content, "utf8");

    const result = await executeGrep("grep-excerpt-cjk", {
      workdir: ".",
      path: "long.txt",
      pattern: "NEEDLE",
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const line = matchLine(getText(result), "NEEDLE");
    expect(line).toMatch(/中{200}NEEDLE/);
    expect(line).not.toContain("\uFFFD");
  });

  it("keeps surrogate pairs intact at excerpt boundaries", async () => {
    // Intent: 600 emoji put the match at byte 2400 and UTF-16 unit 1200 with
    // surrogate pairs around the window edges; the excerpt must be cut on
    // code-point boundaries, never slicing a pair in half.
    const root = await createTempWorkspace();
    const content = `${"🚀".repeat(600)}NEEDLE${"y".repeat(600)}\n`;
    await writeFile(join(root, "long.txt"), content, "utf8");

    const result = await executeGrep("grep-excerpt-emoji", {
      workdir: ".",
      path: "long.txt",
      pattern: "NEEDLE",
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const line = matchLine(getText(result), "NEEDLE");
    // Group the emoji: without /u, a bare quantifier would bind to the low
    // surrogate unit only.
    expect(line).toMatch(/(?:🚀){200}NEEDLE/);
    expect(UNPAIRED_SURROGATE.test(line)).toBe(false);
  });

  it("shows context for a zero-width match deep in a long line", async () => {
    // Intent: zero-width matches (start == end, e.g. "\\b") have no match text
    // to anchor on; the excerpt must still center on the match position.
    // "→" is not a word character, so the only word boundary before the y-run
    // sits right before NEEDLE, deep in the line.
    const root = await createTempWorkspace();
    const content = `${"→".repeat(2500)}NEEDLE${"y".repeat(600)}\n`;
    await writeFile(join(root, "long.txt"), content, "utf8");

    const result = await executeGrep("grep-excerpt-zero-width", {
      workdir: ".",
      path: "long.txt",
      pattern: "\\b",
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const line = matchLine(getText(result), "NEEDLE");
    expect(line).toMatch(/→{200}NEEDLE/);
    expect(UNPAIRED_SURROGATE.test(line)).toBe(false);
  });

  it("anchors a zero-width end-of-line match to the line tail", async () => {
    // Intent: "$" reports start == end at the line's last byte, a point that no
    // strict byte range covers. The excerpt must center on that point so a
    // far-tail NEEDLE stays visible instead of reverting to the line head.
    const root = await createTempWorkspace();
    await writeFile(join(root, "long.txt"), `${"x".repeat(600)}NEEDLE\n`, "utf8");

    const result = await executeGrep("grep-excerpt-eol", {
      workdir: ".",
      path: "long.txt",
      pattern: "$",
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const line = matchLine(getText(result), "NEEDLE");
    expect(line).toMatch(/x{200}NEEDLE/);
    expect(line.length).toBeLessThan(520);
  });

  it("locates excerpts through GBK-encoded lines.bytes blocks", async () => {
    // Intent: non-UTF-8 blocks arrive as base64 `bytes`, and rg reports
    // submatch offsets in raw GBK bytes (2 per character here). Those offsets
    // must be translated to offsets of the decoded text before excerpting;
    // otherwise the window centers on the wrong character and the ASCII match
    // behind a long Chinese prefix stays hidden, as it did before this fix.
    const root = await createTempWorkspace();
    const content = `${"中".repeat(800)}NEEDLE${"y".repeat(600)}\n`;
    await writeFile(join(root, "long.txt"), iconv.encode(content, "gbk"));

    const result = await executeGrep("grep-excerpt-gbk", {
      workdir: ".",
      path: "long.txt",
      pattern: "NEEDLE",
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const line = matchLine(getText(result), "NEEDLE");
    expect(line).toMatch(/中{200}NEEDLE/);
    expect(line).not.toContain("\uFFFD");
  });

  it("shows per-line excerpts for multiline matches spanning long lines", async () => {
    // Intent: multiline submatch offsets cover the whole raw block including
    // line terminators. Each displayed line must clip the match to its own
    // byte range and excerpt around it, so NEEDLE1 at the end of long line 1
    // is no longer hidden by the prefix truncation.
    const root = await createTempWorkspace();
    const content = `${"x".repeat(600)}NEEDLE1\nNEEDLE2\n`;
    await writeFile(join(root, "long.txt"), content, "utf8");

    const result = await executeGrep("grep-excerpt-multiline", {
      workdir: ".",
      path: "long.txt",
      pattern: "NEEDLE1\\nNEEDLE2",
      multiline: true,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const text = getText(result);
    expect(matchLine(text, "NEEDLE1")).toMatch(/x{200}NEEDLE1/);
    expect(matchLine(text, "NEEDLE2")).toContain("NEEDLE2");
  });

  it("renders a multiline match that covers CRLF line endings", async () => {
    // Intent: submatch byte offsets refer to the raw block before CRLF
    // stripping. A match swallowing "\\r\\n" must excerpt correctly on each
    // raw line and still render without stray carriage returns.
    const root = await createTempWorkspace();
    const content = `${"x".repeat(600)}NEEDLE\r\nTAIL\r\n`;
    await writeFile(join(root, "long.txt"), content, "utf8");

    const result = await executeGrep("grep-excerpt-crlf", {
      workdir: ".",
      path: "long.txt",
      pattern: "NEEDLE\\r\\nTAIL",
      multiline: true,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const text = getText(result);
    const needleLine = matchLine(text, "NEEDLE");
    expect(needleLine).toMatch(/x{200}NEEDLE/);
    expect(needleLine).not.toContain("\r");
    expect(matchLine(text, "TAIL")).toContain("TAIL");
  });
});
