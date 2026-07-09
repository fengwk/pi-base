import { describe, expect, it } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piBaseExtension from "../index.js";
import { createToolRegistry } from "./helpers.js";

async function withWorkspace<T>(run: (root: string, registry: any) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pi-base-edit-diff-"));
  try {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    return await run(root, registry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeLines(root: string, path: string, lines: string[]): Promise<void> {
  await writeFile(join(root, path), lines.join("\n") + "\n", "utf8");
}

async function callEdit(
  registry: any,
  root: string,
  oldPath: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): Promise<{ content: Array<{ type: string; text?: string }>; details?: { diff?: string; replacements?: number } }> {
  return registry.getTool("edit").execute(
    "test-call",
    { path: oldPath, workdir: ".", old_string: oldString, new_string: newString, replace_all: replaceAll },
    undefined,
    undefined,
    { cwd: root },
  );
}

describe("edit diff renderer (position-aware context folding)", () => {
  describe("trailing context", () => {
    it("keeps the first contextLines lines closest to the preceding hunk and elides the rest", async () => {
      await withWorkspace(async (root, registry) => {
        // Trailing context = 12 lines. Per git semantics, only the first 4
        // (closest to the preceding hunk) are shown; lines 5-12 are elided.
        const lines: string[] = ["head-1"];
        lines.push("TO-EDIT");
        for (let i = 0; i < 12; i++) lines.push(`tail-${String(i + 1).padStart(2, "0")}`);
        await writeLines(root, "trail.txt", lines);

        const result = await callEdit(registry, root, "trail.txt", "TO-EDIT", "EDITED", false);
        const diff = result.details?.diff ?? "";

        // First 4 trailing context lines (closest to the hunk) are kept.
        expect(diff).toContain("tail-01");
        expect(diff).toContain("tail-02");
        expect(diff).toContain("tail-03");
        expect(diff).toContain("tail-04");
        // Lines beyond the trailing window are elided (no tail rows past tail-04).
        expect(diff).not.toContain("tail-05");
        expect(diff).not.toContain("tail-12");
        // Elision marker.
        expect(diff).toContain("...");
      });
    });

    it("emits no '...' for trailing context of exactly contextLines lines", async () => {
      await withWorkspace(async (root, registry) => {
        const lines: string[] = ["head-1"];
        lines.push("TO-EDIT");
        for (let i = 0; i < 4; i++) lines.push(`tail-${String(i + 1).padStart(2, "0")}`);
        await writeLines(root, "trail4.txt", lines);

        const result = await callEdit(registry, root, "trail4.txt", "TO-EDIT", "EDITED", false);
        const diff = result.details?.diff ?? "";
        expect(diff).not.toContain("...");
        for (let i = 1; i <= 4; i++) {
          expect(diff).toContain(`tail-${String(i).padStart(2, "0")}`);
        }
      });
    });

    it("emits a single '...' for trailing context of contextLines + 1 lines", async () => {
      await withWorkspace(async (root, registry) => {
        const lines: string[] = ["head-1"];
        lines.push("TO-EDIT");
        for (let i = 0; i < 5; i++) lines.push(`tail-${String(i + 1).padStart(2, "0")}`);
        await writeLines(root, "trail5.txt", lines);

        const result = await callEdit(registry, root, "trail5.txt", "TO-EDIT", "EDITED", false);
        const diff = result.details?.diff ?? "";
        // 5 > 4 → must fold: tail-01..tail-04 kept, "...", tail-05 elided.
        expect(diff).toContain("...");
        expect(diff).toContain("tail-01");
        expect(diff).toContain("tail-04");
        // tail-05 is in the elided tail and must not appear.
        expect(diff).not.toContain("tail-05");
      });
    });

    it("does not preserve the trailing tail (matches git, not head+...+tail)", async () => {
      // Regression test for the previous bug: trailing context used to keep
      // the last N lines as a "tail" after the "...". Git's diff -U<N> only
      // keeps the lines closest to the preceding hunk; this test pins that
      // behavior so the head+...+tail algorithm cannot regress.
      await withWorkspace(async (root, registry) => {
        const lines: string[] = ["head-1"];
        lines.push("TO-EDIT");
        for (let i = 0; i < 50; i++) lines.push(`tail-${String(i + 1).padStart(2, "0")}`);
        await writeLines(root, "trail50.txt", lines);

        const result = await callEdit(registry, root, "trail50.txt", "TO-EDIT", "EDITED", false);
        const diff = result.details?.diff ?? "";
        expect(diff).toContain("tail-01");
        expect(diff).toContain("tail-04");
        // Critical: none of the last 4 lines should appear.
        expect(diff).not.toContain("tail-47");
        expect(diff).not.toContain("tail-48");
        expect(diff).not.toContain("tail-49");
        expect(diff).not.toContain("tail-50");
      });
    });
  });

  describe("leading context", () => {
    it("keeps the last contextLines lines closest to the following hunk and elides the rest", async () => {
      await withWorkspace(async (root, registry) => {
        // Leading context = 12 lines. Per git semantics, only the last 4
        // (closest to the following hunk) are shown; lines 1-8 are elided.
        const lines: string[] = [];
        for (let i = 0; i < 12; i++) lines.push(`head-${String(i + 1).padStart(2, "0")}`);
        lines.push("TO-EDIT");
        await writeLines(root, "lead.txt", lines);

        const result = await callEdit(registry, root, "lead.txt", "TO-EDIT", "EDITED", false);
        const diff = result.details?.diff ?? "";

        // Last 4 leading context lines (closest to the hunk) are kept.
        expect(diff).toContain("head-09");
        expect(diff).toContain("head-10");
        expect(diff).toContain("head-11");
        expect(diff).toContain("head-12");
        // Earlier lines are elided.
        expect(diff).not.toContain("head-08");
        expect(diff).not.toContain("head-01");
        // Elision marker.
        expect(diff).toContain("...");
      });
    });

    it("emits no '...' for leading context of exactly contextLines lines", async () => {
      await withWorkspace(async (root, registry) => {
        const lines: string[] = [];
        for (let i = 0; i < 4; i++) lines.push(`head-${String(i + 1).padStart(2, "0")}`);
        lines.push("TO-EDIT");
        await writeLines(root, "lead4.txt", lines);

        const result = await callEdit(registry, root, "lead4.txt", "TO-EDIT", "EDITED", false);
        const diff = result.details?.diff ?? "";
        expect(diff).not.toContain("...");
        for (let i = 1; i <= 4; i++) {
          expect(diff).toContain(`head-${String(i).padStart(2, "0")}`);
        }
      });
    });

    it("emits a single '...' for leading context of contextLines + 1 lines", async () => {
      await withWorkspace(async (root, registry) => {
        const lines: string[] = [];
        for (let i = 0; i < 5; i++) lines.push(`head-${String(i + 1).padStart(2, "0")}`);
        lines.push("TO-EDIT");
        await writeLines(root, "lead5.txt", lines);

        const result = await callEdit(registry, root, "lead5.txt", "TO-EDIT", "EDITED", false);
        const diff = result.details?.diff ?? "";
        // 5 > 4 → fold: head-01 elided, "...", head-02..head-05 kept.
        expect(diff).toContain("...");
        expect(diff).toContain("head-05");
        expect(diff).toContain("head-02");
        // head-01 is in the elided head and must not appear.
        expect(diff).not.toContain("head-01");
      });
    });
  });

  describe("inter-hunk context", () => {
    it("keeps both ends when the gap is short enough to fit two context windows back-to-back", async () => {
      await withWorkspace(async (root, registry) => {
        const lines: string[] = ["L1", "L2", "L3", "L4", "CHANGE", "L6", "L7", "L8"];
        await writeLines(root, "short.txt", lines);

        const result = await callEdit(registry, root, "short.txt", "CHANGE", "EDITED", false);
        const diff = result.details?.diff ?? "";
        expect(diff).not.toContain("...");
        expect(diff).toContain("EDITED");
      });
    });

    it("inserts exactly one '...' when two hunks are separated by more than 2*contextLines", async () => {
      await withWorkspace(async (root, registry) => {
        const lines: string[] = [];
        for (let i = 0; i < 30; i++) lines.push(`ctx-${String(i + 1).padStart(2, "0")}`);
        lines[2] = "MARKER";
        lines[27] = "MARKER";
        await writeLines(root, "g.txt", lines);

        const result = await callEdit(registry, root, "g.txt", "MARKER", "MARKER-new", true);
        const diff = result.details?.diff ?? "";
        expect(diff).toBeDefined();
        const ellipsisCount = (diff.match(/^\.\.\.$/gm) ?? []).length;
        expect(ellipsisCount).toBe(1);
        const markerCount = (diff.match(/MARKER-new/g) ?? []).length;
        expect(markerCount).toBe(2);
      });
    });

    it("merges two hunks without a '...' when their gap fits within 2*contextLines", async () => {
      await withWorkspace(async (root, registry) => {
        // Two MARKER tokens separated by 7 unchanged context lines (≤ 2 * contextLines
        // = 8), so a single replace_all should merge them into one continuous
        // inter-hunk block. Trailing context after the second MARKER is kept
        // short (4 lines = contextLines) so it renders verbatim too, keeping the
        // test focused on the inter-hunk merge behavior.
        const lines: string[] = [];
        for (let i = 0; i < 13; i++) lines.push(`ctx-${String(i + 1).padStart(2, "0")}`);
        lines[2] = "MARKER";
        lines[10] = "MARKER";
        // lines after the last MARKER = ctx-11..ctx-13 = 3 lines, no fold.
        await writeLines(root, "h.txt", lines);

        const result = await callEdit(registry, root, "h.txt", "MARKER", "MARKER-new", true);
        const diff = result.details?.diff ?? "";
        // Inter-hunk gap (lines 4-10) is 7 lines, ≤ 8, so no "..." separator.
        expect(diff).not.toContain("...");
        const markerCount = (diff.match(/MARKER-new/g) ?? []).length;
        expect(markerCount).toBe(2);
      });
    });

    it("emits no '...' for an inter-hunk block of exactly 2*contextLines lines (boundary)", async () => {
      await withWorkspace(async (root, registry) => {
        // Two MARKER tokens separated by exactly 8 unchanged context lines.
        // The block fits two context windows back-to-back and renders verbatim.
        // Trailing context after the second MARKER is exactly 4 lines (≤ contextLines)
        // so it renders verbatim too, keeping the test focused on the inter-hunk
        // boundary alone.
        const lines: string[] = [];
        for (let i = 0; i < 14; i++) lines.push(`ctx-${String(i + 1).padStart(2, "0")}`);
        lines[1] = "MARKER";
        lines[10] = "MARKER";
        // lines after the last MARKER = ctx-11..ctx-14 = 4 lines = contextLines, no fold.
        await writeLines(root, "h8.txt", lines);

        const result = await callEdit(registry, root, "h8.txt", "MARKER", "MARKER-new", true);
        const diff = result.details?.diff ?? "";
        expect(diff).not.toContain("...");
        const markerCount = (diff.match(/MARKER-new/g) ?? []).length;
        expect(markerCount).toBe(2);
      });
    });

    it("emits a single '...' for an inter-hunk block of 2*contextLines + 1 lines (boundary, just over)", async () => {
      await withWorkspace(async (root, registry) => {
        // Two MARKER tokens separated by 9 unchanged context lines. The block
        // is just over the merge threshold, so it folds to head + "..." + tail.
        // Trailing context after the second MARKER is kept short to avoid
        // adding an extra trailing-context "...".
        const lines: string[] = [];
        for (let i = 0; i < 15; i++) lines.push(`ctx-${String(i + 1).padStart(2, "0")}`);
        lines[1] = "MARKER";
        lines[11] = "MARKER";
        // lines after the last MARKER = ctx-12..ctx-15 = 4 lines = contextLines, no fold.
        await writeLines(root, "h9.txt", lines);

        const result = await callEdit(registry, root, "h9.txt", "MARKER", "MARKER-new", true);
        const diff = result.details?.diff ?? "";
        const ellipsisCount = (diff.match(/^\.\.\.$/gm) ?? []).length;
        // Exactly one "..." from the inter-hunk fold.
        expect(ellipsisCount).toBe(1);
        // Inter-hunk head (4 lines closest to hunk1, lines 3-6) and tail
        // (4 lines closest to hunk2, lines 8-11) are kept; line 7 is elided.
        expect(diff).toContain("ctx-03");
        expect(diff).toContain("ctx-06");
        expect(diff).toContain("ctx-08");
        expect(diff).toContain("ctx-11");
        expect(diff).not.toContain("ctx-07");
      });
    });
  });

  describe("error and degenerate paths", () => {
    it("handles a file with no changes by emitting an empty diff", async () => {
      await withWorkspace(async (root, registry) => {
        await writeLines(root, "nochange.txt", ["L1", "L2", "L3", "L4", "L5"]);
        const result = await registry.getTool("edit").execute(
          "test-call",
          { path: "nochange.txt", workdir: ".", old_string: "L3", new_string: "L3" },
          undefined,
          undefined,
          { cwd: root },
        );
        expect(result.isError).toBe(true);
        const text = (result.content ?? [])
          .filter((c: any) => c.type === "text" && typeof c.text === "string")
          .map((c: any) => c.text)
          .join("\n");
        expect(text).toMatch(/identical|no changes/i);
        expect(result.details?.diff).toBeUndefined();
      });
    });

    it("handles a single-line change with no surrounding context", async () => {
      await withWorkspace(async (root, registry) => {
        await writeFile(join(root, "single.txt"), "old\n", "utf8");
        const result = await callEdit(registry, root, "single.txt", "old", "new", false);
        const diff = result.details?.diff ?? "";
        expect(diff).toContain("-1|old");
        expect(diff).toContain("+1|new");
        expect(diff).not.toContain("...");
      });
    });
  });

  describe("real-world regression", () => {
    it("renders a long-edit 3-line block + 10-line trailing context as a tight fold", async () => {
      // Real-world 13-line file: a single edit replaces lines 1-3 (the title
      // line, the blank line, and the opening paragraph). The 10 trailing
      // context lines (4-13) used to be rendered as 4 + '...' + 4 under the
      // unified algorithm. The position-aware algorithm keeps only the 4
      // lines closest to the hunk and elides the rest, matching git.
      await withWorkspace(async (root, registry) => {
        const lines: string[] = [
          "时光旅人",
          "",
          "我叫苏晚，今年二十八岁，是一个普通的图书管理员。每天的工作就是整理书籍、帮读者查找资料。这样的生活平淡而安稳，像一潭静水。直到那个雨夜，一切都改变了。",
          "",
          "那天晚上，我正准备下班关门，忽然发现门口有一封信。信是白色的，没有信封，只有折叠整齐的信纸，上面用漂亮的手写字体写着我的名字。我从未见过这样的信，没有寄件人地址，没有邮戳，没有任何能表明它来源的标记。它就那样静静地躺在图书馆门口的台阶上，被雨水打湿了一角，却奇迹般地没有完全浸透。",
          "",
          "带着满心的疑惑，我小心翼翼地打开信，里面只有短短几行字：\"苏晚小姐，我们诚邀请您参加一场特殊的聚会。时间：明晚子夜时分。地点：城南废弃的钟楼。请务必准时出席，届时您将获得改变一生的机会。——时光的守护者\"",
          "",
          "读完这封信，我第一反应是觉得荒谬。这年头还有人用这种方式邀请人？还什么\"改变一生的机会\"，听起来就像是骗子精心设计的骗局。可是，手指却不听使唤，把那封信收进了包里。也许是直觉，也许是命运，总之我没有拒绝这份神秘的邀请。",
          "",
          "那天晚上回到家，我躺在床上辗转反侧，脑海里不断浮现信上的那些字。\"时光的守护者\"是什么意思？\"改变一生的机会\"又指的是什么？作为一个从小就对神秘事物充满好奇的人，我的内心深处有一个声音在不断怂恿我：去吧，去看看吧，万一是真的呢？",
          "",
          "第二天是周六，我有一整天的休息时间。整个白天我都在犹豫要不要赴约。理智告诉我这很可能是一个陷阱，但直觉却一次次把我推向那个废弃的钟楼。最终，好奇心战胜了理智。",
          "",
          "子夜时分，我站在了城南废弃的钟楼前。这座钟楼建于民国时期，是这座城市最古老的建筑之一。据说在几十年前的一场大火中，钟楼被严重损毁，此后就被一直荒废着。然而此刻，钟楼的大门竟然是敞开的，从门口透出的不是黑暗，而是一片温暖的橘黄色光芒。",
        ];
        await writeLines(root, "story.txt", lines);

        const result = await registry.getTool("edit").execute(
          "test-call",
          {
            path: "story.txt",
            workdir: ".",
            old_string:
              "时光旅人\n\n我叫苏晚，今年二十八岁，是一个普通的图书管理员。",
            new_string:
              "时光旅人：觉醒之路\n\n我叫苏晚，今年二十八岁，是一名普通的图书管理员。",
          },
          undefined,
          undefined,
          { cwd: root },
        );
        const diff = result.details?.diff ?? "";
        // The 3-line hunk (line 1 title, blank line 2, line 3 paragraph) is
        // rendered as two +/- pairs plus the unchanged blank line.
        expect(diff).toContain("- 1|时光旅人");
        expect(diff).toContain("+ 1|时光旅人：觉醒之路");
        expect(diff).toContain("- 3|我叫苏晚");
        expect(diff).toContain("+ 3|我叫苏晚");
        // Inter-hunk blank rendered.
        expect(diff).toContain("  2|");
        // Trailing context: only head 4 (lines 4-7) are kept; the rest is elided.
        expect(diff).toContain("...");
        expect(diff).toContain("那天晚上");
        expect(diff).toContain("带着满心");
        // Critical: lines 8-13 (the "tail") must NOT appear. Use the leading
        // verb of each line to disambiguate from substrings earlier in the file.
        expect(diff).not.toContain("读完这封信");
        expect(diff).not.toContain("我反复读着信");
        expect(diff).not.toContain("第二天是周六，我");
        expect(diff).not.toContain("子夜时分，我站");
      });
    });
  });
});