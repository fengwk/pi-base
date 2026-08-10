import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import piBaseExtension from "../index.js";
import { applyUnifiedOutputTruncation } from "../src/tool-output.js";
import { formatBashWarnings } from "../src/bash-renderer-core.js";
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
    // Intent: cleanup may only remove old directories owned by a dead process; live-process
    // output must survive even when idle longer than the retention window.
    const staleDeadProcess = await mkdtemp(join(tmpdir(), "pi-base-truncation-2147483647-"));
    const staleLiveProcess = await mkdtemp(join(tmpdir(), `pi-base-truncation-${process.pid}-`));
    const recentDeadProcess = await mkdtemp(join(tmpdir(), "pi-base-truncation-2147483647-"));
    const staleUnrelated = await mkdtemp(join(tmpdir(), "pi-base-unrelated-"));
    const staleTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(staleDeadProcess, staleTime, staleTime);
    await utimes(staleLiveProcess, staleTime, staleTime);
    await utimes(staleUnrelated, staleTime, staleTime);
    const big = Array.from({ length: 2505 }, (_, index) => `line-${index + 1}`).join("\n");
    try {
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
      const boundedText = truncated.result.content
        .filter((item: any) => item?.type === "text")
        .map((item: any) => String(item.text ?? ""))
        .join("\n\n");
      expect(Buffer.byteLength(boundedText, "utf8")).toBeLessThanOrEqual(50 * 1024);
      expect(boundedText.split("\n").length).toBeLessThanOrEqual(2000);
      expect((truncated.result as any).details?.source).toBe("test");
      const outputPath = (truncated.result as any).details?.truncation?.outputPath;
      expect(outputPath).toBeTruthy();
      const outputDir = dirname(outputPath);
      expect(dirname(outputDir)).toBe(tmpdir());
      expect(basename(outputDir)).toMatch(new RegExp(`^pi-base-truncation-${process.pid}-.+`));
      expect(outputDir).not.toBe(join(tmpdir(), "pi-base-truncation"));
      const saved = await readFile(outputPath, "utf8");
      expect(saved).toContain("line-2505");
      if (process.platform !== "win32") {
        expect((await stat(outputDir)).mode & 0o777).toBe(0o700);
        expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      }
      if (process.platform === "win32" || typeof process.getuid !== "function") {
        expect((await stat(staleDeadProcess)).isDirectory()).toBe(true);
      } else {
        await expect(stat(staleDeadProcess)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect((await stat(staleLiveProcess)).isDirectory()).toBe(true);
      expect((await stat(recentDeadProcess)).isDirectory()).toBe(true);
      expect((await stat(staleUnrelated)).isDirectory()).toBe(true);
    } finally {
      await Promise.all([
        rm(staleDeadProcess, { recursive: true, force: true }),
        rm(staleLiveProcess, { recursive: true, force: true }),
        rm(recentDeadProcess, { recursive: true, force: true }),
        rm(staleUnrelated, { recursive: true, force: true }),
      ]);
    }
  });

  it("recreates private storage if its cached directory is removed externally", async () => {
    // Intent: OS temp cleanup or an administrator may remove the process directory; one missing
    // cached directory must trigger a fresh private directory instead of losing all later outputs.
    const big = "x".repeat(60 * 1024);
    const first = await applyUnifiedOutputTruncation("recreate-demo", {
      content: [{ type: "text", text: big }],
      details: undefined,
    } as any);
    const firstPath = (first.result as any).details?.truncation?.outputPath;
    expect(firstPath).toBeTruthy();
    await rm(dirname(firstPath), { recursive: true, force: true });

    const second = await applyUnifiedOutputTruncation("recreate-demo", {
      content: [{ type: "text", text: big }],
      details: undefined,
    } as any);
    const secondPath = (second.result as any).details?.truncation?.outputPath;
    expect(secondPath).toBeTruthy();
    expect(dirname(secondPath)).not.toBe(dirname(firstPath));
    expect(await readFile(secondPath, "utf8")).toBe(big);
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

  it("retries private directory creation after a transient failure in the same TMPDIR", async () => {
    // Intent: a rejected cached create promise must be cleared by identity; replacing the same
    // TMPDIR path with a usable directory then proves the next truncation starts a fresh attempt.
    const root = await createTempWorkspace();
    const switchableTmpDir = join(root, "switchable-tmp");
    await writeFile(switchableTmpDir, "temporarily not a directory", "utf8");
    const previousTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = switchableTmpDir;
    try {
      const first = await applyUnifiedOutputTruncation("retry-demo", {
        content: [{ type: "text", text: "x".repeat(60 * 1024) }],
        details: undefined,
      } as any);
      expect((first.result as any).details?.truncation?.outputPath).toBeUndefined();

      await rm(switchableTmpDir);
      await mkdir(switchableTmpDir);
      const second = await applyUnifiedOutputTruncation("retry-demo", {
        content: [{ type: "text", text: "y".repeat(60 * 1024) }],
        details: undefined,
      } as any);
      const outputPath = (second.result as any).details?.truncation?.outputPath;
      expect(outputPath).toBeTruthy();
      expect(dirname(dirname(outputPath))).toBe(switchableTmpDir);
      expect(await readFile(outputPath, "utf8")).toBe("y".repeat(60 * 1024));
    } finally {
      if (previousTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpDir;
      await rm(root, { recursive: true, force: true });
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

  it("preserves upstream bash truncation fields so renderer warnings stay accurate", async () => {
    // Reproduces the production path: the tool_result hook runs applyUnifiedOutputTruncation
    // on an already-truncated bash result, then the bash renderer reads details.truncation.
    // The hook must not erase upstream fields (truncatedBy/outputLines/maxBytes), otherwise
    // formatBashWarnings prints "Truncated: undefined lines shown".
    const outputPath = "/tmp/pi-bash-output.log";
    const upstream = {
      content: [{ type: "text" as const, text: `line-1\n\n[Showing lines 1-1 of 100. Full output: ${outputPath}]` }],
      details: {
        fullOutputPath: outputPath,
        truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 100, maxBytes: 50 * 1024 },
      },
    };
    const hook = await applyUnifiedOutputTruncation("bash", upstream as any);
    expect((hook.result as any).details?.truncation?.alreadyTruncated).toBe(true);
    const warnings = formatBashWarnings(hook.result);
    expect(warnings).toContain(`Full output: ${outputPath}`);
    expect(warnings.some((w) => w.includes("showing 1 of 100 lines"))).toBe(true);
    expect(warnings.some((w) => w.includes("undefined"))).toBe(false);
  });

  it("recognizes structured bash truncation for an oversized single-line preview", async () => {
    // Intent: Pi uses a distinct "Showing last ... of line" footer for byte-truncated single
    // lines, so structured metadata must preserve the true upstream full-output path.
    const outputPath = "/tmp/pi-bash-long-line.log";
    const preview = `${"x".repeat(60 * 1024)}\n\n[Showing last 50KB of line 1 (line is 60KB). Full output: ${outputPath}]`;
    const truncated = await applyUnifiedOutputTruncation("bash", {
      content: [{ type: "text", text: preview }],
      details: {
        fullOutputPath: outputPath,
        truncation: {
          truncated: true,
          truncatedBy: "bytes",
          outputLines: 1,
          totalLines: 1,
          maxBytes: 50 * 1024,
          lastLinePartial: true,
        },
      },
    } as any);

    expect(truncated.truncated).toBe(true);
    expect((truncated.result as any).details?.truncation).toMatchObject({
      truncated: true,
      alreadyTruncated: true,
      outputPath,
      truncatedBy: "bytes",
    });
    const text = String((truncated.result.content[0] as any)?.text);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(50 * 1024);
  });

  it("counts CR-only output toward the final line limit", async () => {
    // Intent: third-party tools may emit classic-Mac CR line endings; the global 2000-line
    // boundary must not depend on LF being present.
    const original = Array.from({ length: 2501 }, (_, index) => `line-${index + 1}`).join("\r");
    const truncated = await applyUnifiedOutputTruncation("third-party", {
      content: [{ type: "text", text: original }],
      details: undefined,
    } as any);

    expect(truncated.truncated).toBe(true);
    const text = truncated.result.content
      .filter((item: any) => item?.type === "text")
      .map((item: any) => String(item.text ?? ""))
      .join("\n\n");
    expect(text.replace(/\r\n?/g, "\n").split("\n").length).toBeLessThanOrEqual(2000);
    const outputPath = (truncated.result as any).details?.truncation?.outputPath;
    expect(await readFile(outputPath, "utf8")).toBe(original);
  });

  it("marks already-truncated long-line output even when below pi-base size limits", async () => {
    const preview = "short line\n... (line truncated to 2000 chars)";
    const truncated = await applyUnifiedOutputTruncation("grep", {
      content: [{ type: "text", text: preview }],
      details: { upstreamTextTruncated: true },
    } as any);
    expect(truncated.truncated).toBe(true);
    expect((truncated.result.content[0] as any)?.text).toBe(preview);
    expect((truncated.result as any).details?.truncation?.alreadyTruncated).toBe(true);
  });

  it("reapplies the final limit to oversized upstream-truncated previews", async () => {
    // Intent: upstream truncation means the full body must not be saved again, but it cannot allow
    // an oversized remaining preview to bypass pi-base's documented final model-output boundary.
    const outputPath = `/tmp/${"p".repeat(60 * 1024)}`;
    const oversizedPreview = "x".repeat(80 * 1024);
    const truncated = await applyUnifiedOutputTruncation("grep", {
      content: [{ type: "text", text: oversizedPreview }],
      details: {
        upstreamTextTruncated: true,
        truncation: { truncated: true, outputPath, truncatedBy: "bytes" },
      },
    } as any);

    expect(truncated.truncated).toBe(true);
    const text = String((truncated.result.content[0] as any)?.text);
    expect(text).not.toBe(oversizedPreview);
    expect(text).toContain("upstream tool had already truncated");
    expect(text).not.toContain(outputPath);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(text.split("\n").length).toBeLessThanOrEqual(2000);
    expect((truncated.result as any).details?.truncation).toMatchObject({
      truncated: true,
      alreadyTruncated: true,
      outputPath,
      truncatedBy: "bytes",
    });
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
