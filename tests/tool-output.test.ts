import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piBaseExtension from "../index.js";
import { applyUnifiedOutputTruncation } from "../src/tool-output.js";
import { createTempWorkspace, createToolRegistry } from "./helpers.js";

describe("tool output truncation", () => {
  it("returns small text output unchanged", async () => {
    const truncated = await applyUnifiedOutputTruncation("demo", {
      content: [{ type: "text", text: "hello" }],
      details: undefined,
    } as any);
    expect(truncated.truncated).toBe(false);
    expect((truncated.result.content[0] as any)?.text).toBe("hello");
    expect((truncated.result as any).details?.truncation).toBeUndefined();
  });

  it("leaves non-text outputs unchanged", async () => {
    const image = { type: "image", mimeType: "image/png", data: "x" } as any;
    const truncated = await applyUnifiedOutputTruncation("demo", {
      content: [image],
      details: undefined,
    } as any);
    expect(truncated.truncated).toBe(false);
    expect(truncated.result.content).toEqual([image]);
  });

  it("truncates large text output, preserves attachments, and writes the full output", async () => {
    const big = Array.from({ length: 2505 }, (_, index) => `line-${index + 1}`).join("\n");
    const truncated = await applyUnifiedOutputTruncation("demo", {
      content: [
        { type: "text", text: big },
        { type: "image", mimeType: "image/png", data: "x" },
        { type: "text", text: "ignored second text part" },
      ],
      details: { source: "test" },
    } as any);
    expect(truncated.truncated).toBe(true);
    expect((truncated.result.content[0] as any)?.type).toBe("text");
    expect(String((truncated.result.content[0] as any)?.text)).toContain("The tool call succeeded but the output was truncated");
    expect((truncated.result.content[1] as any)?.type).toBe("image");
    expect((truncated.result as any).details?.source).toBe("test");
    const outputPath = (truncated.result as any).details?.truncation?.outputPath;
    expect(outputPath).toBeTruthy();
    expect(outputPath).toContain(join(tmpdir(), "pi-base-truncation"));
    const saved = await readFile(outputPath, "utf8");
    expect(saved).toContain("line-2505");
  });

  it("keeps a bounded preview when temporary full-output storage is unavailable", async () => {
    // Intent: saving the full body is auxiliary; a broken TMPDIR must not turn a successful tool
    // result into an extension error or allow the oversized output through unbounded.
    const root = await createTempWorkspace();
    const notADirectory = join(root, "tmp-file");
    await writeFile(notADirectory, "not a directory", "utf8");
    const previousTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = notADirectory;
    try {
      const truncated = await applyUnifiedOutputTruncation("demo", {
        content: [{ type: "text", text: "x".repeat(60 * 1024) }],
        details: { source: "test" },
      } as any);

      expect(truncated.truncated).toBe(true);
      const text = String((truncated.result.content[0] as any)?.text);
      expect(text).toContain("output was truncated");
      expect(text).toContain("Full output could not be saved to temporary storage");
      expect(text.length).toBeLessThan(2_000);
      expect((truncated.result as any).details?.truncation?.outputPath).toBeUndefined();
    } finally {
      if (previousTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpDir;
    }
  });

  it("preserves original item order when truncation happens in a later text block", async () => {
    const big = Array.from({ length: 2505 }, (_, index) => `tail-${index + 1}`).join("\n");
    const truncated = await applyUnifiedOutputTruncation("demo", {
      content: [
        { type: "text", text: "intro" },
        { type: "image", mimeType: "image/png", data: "x" },
        { type: "text", text: big },
      ],
      details: undefined,
    } as any);
    expect(truncated.truncated).toBe(true);
    expect((truncated.result.content[0] as any)?.type).toBe("text");
    expect((truncated.result.content[0] as any)?.text).toBe("intro");
    expect((truncated.result.content[1] as any)?.type).toBe("image");
    expect((truncated.result.content[2] as any)?.type).toBe("text");
    expect(String((truncated.result.content[2] as any)?.text)).toContain("The tool call succeeded but the output was truncated");
  });

  it("respects already-truncated upstream output without writing pi-base-truncation files", async () => {
    const preview = "line-1\nline-2\n[Showing lines 1001-3000 of 3000. Full output: /tmp/pi-bash-demo.log]";
    const truncated = await applyUnifiedOutputTruncation("bash", {
      content: [{ type: "text", text: preview }],
      details: { source: "pi-builtin-bash" },
    } as any);
    expect(truncated.truncated).toBe(true);
    const details = (truncated.result as any).details;
    expect(details.truncation.alreadyTruncated).toBe(true);
    expect(details.truncation.outputPath).toBe("/tmp/pi-bash-demo.log");
  });

  it("marks already-truncated long-line output even when below pi-base size limits", async () => {
    const truncated = await applyUnifiedOutputTruncation("grep", {
      content: [{ type: "text", text: "short line\n... (line truncated to 2000 chars)" }],
      details: { upstreamTextTruncated: true },
    } as any);
    expect(truncated.truncated).toBe(true);
    expect((truncated.result as any).details?.truncation?.alreadyTruncated).toBe(true);
  });

  it("recognizes grep's native truncation metadata as upstream truncation", async () => {
    const truncated = await applyUnifiedOutputTruncation("grep", {
      content: [{ type: "text", text: "short line" }],
      details: { linesTruncated: true },
    } as any);
    expect(truncated.truncated).toBe(true);
    expect((truncated.result as any).details?.truncation?.alreadyTruncated).toBe(true);
  });

  it("respects find's own truncation metadata instead of truncating the truncated preview again", async () => {
    const truncated = await applyUnifiedOutputTruncation("find", {
      content: [{ type: "text", text: "preview line\n\n[10 results limit reached. Use limit=20 for more, or refine pattern]" }],
      details: { truncation: { truncated: true, outputLines: 1, totalLines: 100 } },
    } as any);
    expect(truncated.truncated).toBe(true);
    expect((truncated.result as any).details?.truncation?.alreadyTruncated).toBe(true);
  });

  it("does not infer read/grep truncation from ordinary content without explicit metadata", async () => {
    const truncated = await applyUnifiedOutputTruncation("grep", {
      content: [{ type: "text", text: "literal text ... (line truncated to 2000 chars)" }],
      details: undefined,
    } as any);
    expect(truncated.truncated).toBe(false);
  });

  it("does not treat ordinary text as upstream truncation just because it mentions generic limit words", async () => {
    const truncated = await applyUnifiedOutputTruncation("demo", {
      content: [{ type: "text", text: "The user wrote: output was truncated because limit reached in an unrelated log." }],
      details: undefined,
    } as any);
    expect(truncated.truncated).toBe(false);
  });

  it("tool_result truncation applies to tools outside pi-base registrations", async () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    registry.pi.registerTool({
      name: "demo",
      label: "demo",
      description: "demo",
      promptSnippet: "demo",
      parameters: {},
      async execute() {
        return {
          content: [{ type: "text", text: Array.from({ length: 2505 }, (_, index) => `line-${index + 1}`).join("\n") }],
          details: undefined,
        };
      },
    });
    const result = await registry.getTool("demo").execute("1", {}, undefined, undefined, {});
    expect(String((result.content[0] as any)?.text)).toContain("output was truncated");
  });
});
