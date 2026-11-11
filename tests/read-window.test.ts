import { describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registerReadTool } from "../src/read.js";
import { readSchema } from "../src/schemas/read.js";
import { applyUnifiedOutputTruncation, TOOL_OUTPUT_MAX_BYTES, TOOL_OUTPUT_MAX_LINES } from "../src/tool-output-core.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

async function executeRead(root: string, params: Record<string, unknown>) {
  const registry = createToolRegistry();
  registerReadTool(registry.pi as any);
  return registry.getTool("read").execute("1", { workdir: ".", ...params }, undefined, undefined, { cwd: root });
}

function renderCall(args: Record<string, unknown>): string {
  const registry = createToolRegistry();
  registerReadTool(registry.pi as any);
  return registry.getTool("read").renderCall(args, {} as any, { lastComponent: undefined }).render(200).join("\n");
}

function firstLineContent(text: string): string {
  const match = text.match(/^ *1\|(.*)$/m);
  if (!match) throw new Error("read output has no numbered line 1");
  return match[1]!;
}

async function followReadNotices(root: string, path: string, initialText: string): Promise<string> {
  const collected: string[] = [];
  let text = initialText;
  for (let guard = 0; guard < 200; guard += 1) {
    for (const match of text.matchAll(/^ *\d+\|(.*)$/gm)) collected.push(match[1]!);
    const notice = text.match(/Re-run read with offset=(\d+)(?:, column_offset=(\d+))? to continue/);
    if (!notice) return collected.join("\n");
    const params: Record<string, unknown> = { path, offset: Number(notice[1]!) };
    if (notice[2]) params.column_offset = Number(notice[2]);
    text = getText(await executeRead(root, params));
  }
  throw new Error("read continuation did not terminate");
}

describe("read window contract", () => {
  it("exposes column_offset in the schema and the call renderer", () => {
    expect(readSchema.properties.column_offset).toBeDefined();
    expect(renderCall({ path: "src/example.ts", offset: 2, column_offset: 2001 })).toContain("column_offset=2001");
  });

  it("applies column_offset to the first returned line only", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/columns.txt", `${"a".repeat(3000)}\nbeta\ngamma\n`);
    const result = await executeRead(root, { path: "src/columns.txt", offset: 1, column_offset: 2001, limit: 10 });
    expect(result.isError).not.toBe(true);
    const text = getText(result);
    // Intent: a mid-line window must never read like a complete source line, so
    // the header names the column fragment even when no continuation notice follows.
    expect(text).toContain("column_offset: 2001 (first displayed line starts mid-line; earlier columns omitted)");
    const bodyLines = text.split("\n").filter((line) => /^ *\d+\|/.test(line));
    expect(bodyLines).toEqual([
      `1|${"a".repeat(1000)}`,
      "2|beta",
      "3|gamma",
    ]);
    expect(text).not.toContain("Re-run read");

    const fromStart = await executeRead(root, { path: "src/columns.txt", offset: 1 });
    expect(fromStart.isError).not.toBe(true);
    expect(getText(fromStart)).not.toContain("column_offset:");
  });

  it("stops the window at the first cut line and resumes from the exact next column", async () => {
    const root = await createTempWorkspace();
    const longLine = "x".repeat(5000);
    await writeWorkspaceFile(root, "src/long-line.txt", `${longLine}\ntail\n`);

    const first = await executeRead(root, { path: "src/long-line.txt" });
    const firstText = getText(first);
    expect(firstText.split("\n")).toContain(`1|${"x".repeat(2000)}`);
    expect(firstText).not.toContain("tail");
    expect(firstText).toContain(
      "[Line 1 was cut at column 2001; lines after 1 were not shown. Re-run read with offset=1, column_offset=2001 to continue this line.]",
    );
    expect(first.details).toMatchObject({ upstreamTextTruncated: true, next: { line: 1, column: 2001 } });

    const second = await executeRead(root, { path: "src/long-line.txt", offset: 1, column_offset: 2001 });
    const secondText = getText(second);
    expect(secondText).toContain("column_offset: 2001 (first displayed line starts mid-line; earlier columns omitted)");
    expect(secondText.split("\n")).toContain(`1|${"x".repeat(2000)}`);
    expect(secondText).not.toContain("tail");
    expect(second.details).toMatchObject({ upstreamTextTruncated: true, next: { line: 1, column: 4001 } });

    const third = await executeRead(root, { path: "src/long-line.txt", offset: 1, column_offset: 4001 });
    const thirdText = getText(third);
    expect(thirdText).toContain(`1|${"x".repeat(1000)}`);
    expect(thirdText).toContain("2|tail");
    expect(thirdText).not.toContain("Re-run read");
    expect(third.details?.upstreamTextTruncated).toBeUndefined();
    expect(third.details?.next).toBeUndefined();

    expect([firstText, secondText, thirdText].map(firstLineContent).join("")).toBe(longLine);
  });

  it("keeps mixed Unicode intact at the 2000-code-point boundary and resumes without splitting pairs", async () => {
    const root = await createTempWorkspace();
    const exactLine = `${"a".repeat(1999)}🚀`;
    await writeWorkspaceFile(root, "src/emoji-exact.txt", `${exactLine}\n`);
    const exact = await executeRead(root, { path: "src/emoji-exact.txt" });
    const exactText = getText(exact);
    expect(exactText).toContain(`1|${exactLine}`);
    expect(exactText).not.toContain("truncated");
    expect(exact.details?.upstreamTextTruncated).toBeUndefined();
    expect(exact.details?.next).toBeUndefined();

    await writeWorkspaceFile(root, "src/emoji-over.txt", `${"😀".repeat(2001)}\n`);
    const over = await executeRead(root, { path: "src/emoji-over.txt" });
    const overText = getText(over);
    const head = Array.from(firstLineContent(overText));
    expect(head.length).toBe(2000);
    expect(head.every((codePoint) => codePoint === "😀")).toBe(true);
    expect(over.details).toMatchObject({ upstreamTextTruncated: true, next: { line: 1, column: 2001 } });

    const rest = await executeRead(root, { path: "src/emoji-over.txt", offset: 1, column_offset: 2001 });
    expect(`${firstLineContent(overText)}${firstLineContent(getText(rest))}`).toBe("😀".repeat(2001));
  });

  it("rejects out-of-bounds columns and keeps column 1 legal everywhere", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/short.txt", "abc\n\ntail\n");

    const beyondEnd = await executeRead(root, { path: "src/short.txt", offset: 1, column_offset: 4 });
    expect(beyondEnd.isError).toBe(true);
    expect(getText(beyondEnd)).toContain("column_offset 4 is out of bounds for line 1 (3 code points)");

    const emptyLineBeyond = await executeRead(root, { path: "src/short.txt", offset: 2, column_offset: 2 });
    expect(emptyLineBeyond.isError).toBe(true);

    const emptyLineFirst = await executeRead(root, { path: "src/short.txt", offset: 2, column_offset: 1 });
    expect(emptyLineFirst.isError).not.toBe(true);
    expect(getText(emptyLineFirst)).toContain("\n2|");

    await writeWorkspaceFile(root, "src/empty.txt", "");
    const emptyFileFirst = await executeRead(root, { path: "src/empty.txt", column_offset: 1 });
    expect(emptyFileFirst.isError).not.toBe(true);
    expect(getText(emptyFileFirst)).toContain("ends_with_newline: no");

    const emptyFileBeyond = await executeRead(root, { path: "src/empty.txt", column_offset: 3 });
    expect(emptyFileBeyond.isError).toBe(true);
    expect(getText(emptyFileBeyond)).toContain("column_offset 3");
  });

  it("rejects explicit column_offset for directory and image reads", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src", "dir"), { recursive: true });
    await writeWorkspaceFile(root, "image.png", "fake");

    const directory = await executeRead(root, { path: "src/dir", column_offset: 2 });
    expect(directory.isError).toBe(true);
    expect(getText(directory)).toContain("column_offset is only supported for text file reads");

    const image = await executeRead(root, { path: "image.png", column_offset: 2 });
    expect(image.isError).toBe(true);
    expect(getText(image)).toContain("column_offset is only supported for text file reads");
  });

  it("accepts string columns and validates invalid columns before filesystem access", async () => {
    // The new argument follows offset/limit's numeric-string contract, with
    // Unicode columns rather than UTF-16 indices or byte offsets.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "columns.txt", "A🚀Z\n");
    const result = await executeRead(root, { path: "columns.txt", column_offset: "2", limit: 1 });
    expect(result.isError).not.toBe(true);
    expect(firstLineContent(getText(result))).toBe("🚀Z");
    const invalid = await executeRead(root, { path: "missing.txt", column_offset: 0 });
    expect(invalid.isError).toBe(true);
    expect(getText(invalid)).toContain("column_offset must be a positive integer");
    expect(getText(invalid)).not.toContain("ENOENT");
  });

  it("rejects metadata-heavy windows instead of returning a non-advancing cursor", async () => {
    // A normalized path may be short on disk but arbitrarily verbose in the
    // header. Returning no body with the same cursor would make continuation loop.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "large.txt", `${"x".repeat(1000)}\n`);
    const result = await executeRead(root, { path: `${"./".repeat(25000)}large.txt`, column_offset: 2 });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Use a shorter path");
    expect(getText(result)).not.toContain("Re-run read");
    expect(result.details?.next).toBeUndefined();
  });

  it("keeps past-end offsets legal without inventing rows", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/three.txt", "one\ntwo\nthree\n");
    const pastEnd = await executeRead(root, { path: "src/three.txt", offset: 4 });
    const pastEndText = getText(pastEnd);
    expect(pastEnd.isError).not.toBe(true);
    expect(pastEndText).toContain("ends_with_newline: yes");
    expect(pastEndText).not.toMatch(/^ *\d+\|/m);
    expect(pastEndText).not.toContain("Re-run read");
  });

  it("keeps wide byte windows inside the shared output budget and resumes without holes", async () => {
    const root = await createTempWorkspace();
    const lineText = "y".repeat(1500);
    const totalLines = 60;
    const original = `${Array.from({ length: totalLines }, () => lineText).join("\n")}\n`;
    await writeWorkspaceFile(root, "src/wide.txt", original);

    const first = await executeRead(root, { path: "src/wide.txt", limit: 2000 });
    const firstText = getText(first);
    expect(Buffer.byteLength(firstText, "utf8")).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES);
    expect(firstText.split("\n").length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_LINES);
    expect(first.details?.upstreamTextTruncated).toBeUndefined();

    const notice = firstText.match(/\[Showing lines (\d+)-(\d+) of (\d+)\. Re-run read with offset=(\d+) to continue\.\]/);
    expect(notice).not.toBeNull();
    const shownThrough = Number(notice![2]!);
    expect(shownThrough).toBeGreaterThan(0);
    expect(shownThrough).toBeLessThan(totalLines);
    expect(Number(notice![4]!)).toBe(shownThrough + 1);

    const unified = await applyUnifiedOutputTruncation("read", first as any);
    expect(unified.truncated).toBe(false);
    expect(getText(unified.result)).toBe(firstText);
    expect(await followReadNotices(root, "src/wide.txt", firstText)).toBe(original.replace(/\n$/, ""));
  });

  it("keeps wide line windows inside the shared line budget and resumes without holes", async () => {
    const root = await createTempWorkspace();
    const totalLines = 3000;
    const originalLines = Array.from({ length: totalLines }, (_, index) => `line-${index + 1}`);
    await writeWorkspaceFile(root, "src/many.txt", `${originalLines.join("\n")}\n`);

    const first = await executeRead(root, { path: "src/many.txt", limit: 2000 });
    const firstText = getText(first);
    expect(firstText.split("\n").length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_LINES);
    const notice = firstText.match(/\[Showing lines 1-(\d+) of 3000\. Re-run read with offset=(\d+) to continue\.\]/);
    expect(notice).not.toBeNull();
    const shownThrough = Number(notice![1]!);
    expect(shownThrough).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_LINES - 7);
    expect(firstText).toContain(`\n${shownThrough}|line-${shownThrough}`);
    expect(firstText).not.toContain(`\n${shownThrough + 1}|`);

    const collected = await followReadNotices(root, "src/many.txt", firstText);
    expect(collected.split("\n")).toEqual(originalLines);
  });

  it("keeps the windowed body and cursor intact through applyUnifiedOutputTruncation", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/long-line.txt", `${"x".repeat(5000)}\ntail\n`);
    await writeWorkspaceFile(root, "src/plain.txt", "one\ntwo\n");

    const capped = await executeRead(root, { path: "src/long-line.txt" });
    const unifiedCapped = await applyUnifiedOutputTruncation("read", capped as any);
    expect(getText(unifiedCapped.result)).toBe(getText(capped));
    expect(unifiedCapped.result.details?.next).toEqual({ line: 1, column: 2001 });
    expect(unifiedCapped.result.details?.truncation?.alreadyTruncated).toBe(true);

    const plain = await executeRead(root, { path: "src/plain.txt" });
    const unifiedPlain = await applyUnifiedOutputTruncation("read", plain as any);
    expect(unifiedPlain.truncated).toBe(false);
    expect(getText(unifiedPlain.result)).toBe(getText(plain));
  });
});
