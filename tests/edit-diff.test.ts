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

describe("edit diff renderer", () => {
  it("folds the leading context to contextLines + ... when it is longer than 2*contextLines", async () => {
    await withWorkspace(async (root, registry) => {
      // 12 lines of leading context, then the change.
      // 12 > 2 * contextLines (8), so the renderer must keep only the first
      // contextLines (4) lines and "..." the rest.
      const lines: string[] = [];
      for (let i = 0; i < 12; i++) lines.push(`head-${String(i + 1).padStart(2, "0")}`);
      lines.push("TO-EDIT");
      await writeLines(root, "lead.txt", lines);

      const result = await callEdit(registry, root, "lead.txt", "TO-EDIT", "EDITED", false);
      const diff = result.details?.diff ?? "";

      // First 4 context lines are kept
      expect(diff).toContain("head-01");
      expect(diff).toContain("head-02");
      expect(diff).toContain("head-03");
      expect(diff).toContain("head-04");
      // Lines beyond the head window are elided
      expect(diff).not.toContain("head-05");
      // Elision marker
      expect(diff).toContain("...");
      // The change itself
      expect(diff).toContain("EDITED");
    });
  });

  it("folds the trailing context to contextLines + ... + contextLines when it is longer than 2*contextLines", async () => {
    await withWorkspace(async (root, registry) => {
      const lines: string[] = ["head-1"];
      lines.push("TO-EDIT");
      for (let i = 0; i < 12; i++) lines.push(`tail-${String(i + 1).padStart(2, "0")}`);
      await writeLines(root, "trail.txt", lines);

      const result = await callEdit(registry, root, "trail.txt", "TO-EDIT", "EDITED", false);
      const diff = result.details?.diff ?? "";

      // The head context window (4 lines after the change) is kept verbatim.
      expect(diff).toContain("tail-01");
      expect(diff).toContain("tail-02");
      expect(diff).toContain("tail-03");
      expect(diff).toContain("tail-04");
      // Middle window elided
      expect(diff).not.toContain("tail-05");
      expect(diff).not.toContain("tail-06");
      expect(diff).not.toContain("tail-07");
      expect(diff).not.toContain("tail-08");
      // The tail context window (last 4 lines) is kept verbatim.
      expect(diff).toContain("tail-09");
      expect(diff).toContain("tail-10");
      expect(diff).toContain("tail-11");
      expect(diff).toContain("tail-12");
      // Elision marker
      expect(diff).toContain("...");
    });
  });

  it("emits no '...' for short context blocks (single hunk, file fits in window)", async () => {
    await withWorkspace(async (root, registry) => {
      // Total file is 8 lines, change in the middle: every line is within
      // 2 * contextLines of the change, so the renderer keeps it all.
      const lines = ["L1", "L2", "L3", "L4", "CHANGE", "L6", "L7", "L8"];
      await writeLines(root, "short.txt", lines);

      const result = await callEdit(registry, root, "short.txt", "CHANGE", "EDITED", false);
      const diff = result.details?.diff ?? "";
      expect(diff).not.toContain("...");
      expect(diff).toContain("EDITED");
    });
  });

  it("inserts a single '...' between two hunks when their gap exceeds 2*contextLines", async () => {
    await withWorkspace(async (root, registry) => {
      // Two distinct MARKER tokens far apart. Both share the same old_string
      // pattern via replace_all so a single edit produces two hunks in one diff.
      const lines: string[] = [];
      for (let i = 0; i < 30; i++) lines.push(`ctx-${String(i + 1).padStart(2, "0")}`);
      lines[2] = "MARKER";
      lines[27] = "MARKER";
      await writeLines(root, "g.txt", lines);

      const result = await callEdit(registry, root, "g.txt", "MARKER", "MARKER-new", true);
      const diff = result.details?.diff ?? "";
      expect(diff).toBeDefined();
      // Two single-line hunks, ~24 lines apart. The inter-hunk gap is > 8
      // lines, so the renderer must insert exactly one "...".
      const ellipsisCount = (diff.match(/^\.\.\.$/gm) ?? []).length;
      expect(ellipsisCount).toBe(1);
      // Both replacements show up
      const markerCount = (diff.match(/MARKER-new/g) ?? []).length;
      expect(markerCount).toBe(2);
    });
  });

  it("merges two hunks without a '...' when their gap fits within 2*contextLines", async () => {
    await withWorkspace(async (root, registry) => {
      // Two MARKER tokens 7 unchanged context lines apart (≤ 2*contextLines=8),
      // so a single replace_all should merge them into one continuous block.
      const lines: string[] = [];
      for (let i = 0; i < 20; i++) lines.push(`ctx-${String(i + 1).padStart(2, "0")}`);
      lines[2] = "MARKER";
      lines[11] = "MARKER";
      await writeLines(root, "h.txt", lines);

      const result = await callEdit(registry, root, "h.txt", "MARKER", "MARKER-new", true);
      const diff = result.details?.diff ?? "";
      // Gap is 7 lines (ctx-03..ctx-10) which is ≤ 2 * contextLines (8), so
      // the two hunks should merge into a single context block with no "...".
      expect(diff).not.toContain("...");
      const markerCount = (diff.match(/MARKER-new/g) ?? []).length;
      expect(markerCount).toBe(2);
    });
  });

  it("emits a single '...' when context block is exactly 2*contextLines + 1 lines long (just over the merge threshold)", async () => {
    await withWorkspace(async (root, registry) => {
      // Trailing context = 9 lines (== 2*contextLines + 1). The boundary check
      // is strict: < or <= triggers different branches, so a 9-line block must
      // fold while an 8-line block must not.
      const lines: string[] = ["head-1"];
      lines.push("TO-EDIT");
      for (let i = 0; i < 9; i++) lines.push(`tail-${String(i + 1).padStart(2, "0")}`);
      await writeLines(root, "edge9.txt", lines);

      const result = await callEdit(registry, root, "edge9.txt", "TO-EDIT", "EDITED", false);
      const diff = result.details?.diff ?? "";
      // 9 > 8 → must fold: head 4 lines, "...", tail 4 lines (line 9 elided).
      expect(diff).toContain("...");
      expect(diff).toContain("tail-01");
      expect(diff).toContain("tail-04");
      expect(diff).toContain("tail-06"); // 9 - 4 = 5, so tail-06..tail-09 are the last 4
      expect(diff).toContain("tail-09");
      // tail-05 is in the elided middle and must not appear
      expect(diff).not.toContain("tail-05");
    });
  });

  it("emits no '...' when context block is exactly 2*contextLines lines long (boundary, no fold)", async () => {
    await withWorkspace(async (root, registry) => {
      // Trailing context = 8 lines (== 2*contextLines). This is the boundary
      // case where the block fits in two context windows back-to-back and
      // must be rendered verbatim with no "..." separator.
      const lines: string[] = ["head-1"];
      lines.push("TO-EDIT");
      for (let i = 0; i < 8; i++) lines.push(`tail-${String(i + 1).padStart(2, "0")}`);
      await writeLines(root, "edge8.txt", lines);

      const result = await callEdit(registry, root, "edge8.txt", "TO-EDIT", "EDITED", false);
      const diff = result.details?.diff ?? "";
      // 8 ≤ 8 → all 8 lines verbatim, no elision marker
      expect(diff).not.toContain("...");
      for (let i = 1; i <= 8; i++) {
        expect(diff).toContain(`tail-${String(i).padStart(2, "0")}`);
      }
    });
  });

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
      // No change to apply: the tool should refuse before reaching the renderer.
      // The error result has no diff details.
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
      // File is exactly one line that gets replaced. No context blocks at all.
      await writeFile(join(root, "single.txt"), "old\n", "utf8");
      const result = await callEdit(registry, root, "single.txt", "old", "new", false);
      const diff = result.details?.diff ?? "";
      expect(diff).toContain("-1|old");
      expect(diff).toContain("+1|new");
      expect(diff).not.toContain("...");
    });
  });

  it("folds a 3-hunk file with mixed gap sizes correctly", async () => {
    await withWorkspace(async (root, registry) => {
      // Three MARKER tokens: 12 lines apart, 3 lines apart, 12 lines apart.
      // Expected diff layout:
      //   - hunk1 (line 3)
      //   - 12-line gap ctx-04..ctx-15 → folded: ctx-04..ctx-07 + "..." + ctx-12..ctx-15
      //   - hunk2 (line 16)
      //   - 3-line gap ctx-17..ctx-19 → merged (≤ 8), no "..."
      //   - hunk3 (line 20)
      //   - 40-line trailing context → folded: ctx-21..ctx-24 + "..." + ctx-57..ctx-60
      // Total: exactly 2 "..." markers.
      const lines: string[] = [];
      for (let i = 0; i < 60; i++) lines.push(`ctx-${String(i + 1).padStart(2, "0")}`);
      lines[2] = "MARKER";
      lines[15] = "MARKER";
      lines[19] = "MARKER";
      await writeLines(root, "three.txt", lines);

      const result = await registry.getTool("edit").execute(
        "test-call",
        { path: "three.txt", workdir: ".", old_string: "MARKER", new_string: "MARKER-new", replace_all: true },
        undefined,
        undefined,
        { cwd: root },
      );
      const diff = result.details?.diff ?? "";
      const markerCount = (diff.match(/MARKER-new/g) ?? []).length;
      expect(markerCount).toBe(3);
      // Exactly two folds: 12-line inter-hunk + 40-line trailing. The 3-line
      // middle gap is merged without a separator.
      const ellipsisCount = (diff.match(/^\.\.\.$/gm) ?? []).length;
      expect(ellipsisCount).toBe(2);
    });
  });

  it("emits no '...' for a leading context block of exactly 2*contextLines (boundary, no fold)", async () => {
    await withWorkspace(async (root, registry) => {
      // Leading context = 8 lines (== 2*contextLines). Same boundary as the
      // trailing-context test; if appendContextBlock is genuinely position-
      // agnostic, this must pass identically.
      const lines: string[] = [];
      for (let i = 0; i < 8; i++) lines.push(`head-${String(i + 1).padStart(2, "0")}`);
      lines.push("TO-EDIT");
      lines.push("tail-1");
      await writeLines(root, "leading8.txt", lines);

      const result = await callEdit(registry, root, "leading8.txt", "TO-EDIT", "EDITED", false);
      const diff = result.details?.diff ?? "";
      // 8 ≤ 8 → all 8 head lines verbatim, no elision marker.
      expect(diff).not.toContain("...");
      for (let i = 1; i <= 8; i++) {
        expect(diff).toContain(`head-${String(i).padStart(2, "0")}`);
      }
    });
  });

  it("emits a '...' for a leading context block of exactly 2*contextLines + 1 (boundary, fold)", async () => {
    await withWorkspace(async (root, registry) => {
      // Leading context = 9 lines (== 2*contextLines + 1). Mirror of the
      // trailing 9-line boundary case.
      const lines: string[] = [];
      for (let i = 0; i < 9; i++) lines.push(`head-${String(i + 1).padStart(2, "0")}`);
      lines.push("TO-EDIT");
      lines.push("tail-1");
      await writeLines(root, "leading9.txt", lines);

      const result = await callEdit(registry, root, "leading9.txt", "TO-EDIT", "EDITED", false);
      const diff = result.details?.diff ?? "";
      // 9 > 8 → must fold: head 4, "...", tail 4 (head-05 elided).
      expect(diff).toContain("...");
      expect(diff).toContain("head-01");
      expect(diff).toContain("head-04");
      expect(diff).toContain("head-06");
      expect(diff).toContain("head-09");
      expect(diff).not.toContain("head-05");
    });
  });

  it("folds a file with a single leading context block longer than 2*contextLines", async () => {
    await withWorkspace(async (root, registry) => {
      // Pure leading context > 8, then change, then short tail. Exercises the
      // !nextPartIsChange=false path (the block is preceded by nothing, followed
      // by a change) and confirms it folds the same way as trailing context.
      const lines: string[] = [];
      for (let i = 0; i < 20; i++) lines.push(`head-${String(i + 1).padStart(2, "0")}`);
      lines.push("TO-EDIT");
      await writeLines(root, "leading20.txt", lines);

      const result = await callEdit(registry, root, "leading20.txt", "TO-EDIT", "EDITED", false);
      const diff = result.details?.diff ?? "";
      // 20 > 8 → head 4 + "..." + head-17..head-20 (last 4).
      expect(diff).toContain("head-01");
      expect(diff).toContain("head-04");
      expect(diff).not.toContain("head-10");
      expect(diff).toContain("head-17");
      expect(diff).toContain("head-20");
      expect(diff).toContain("...");
    });
  });

  it("folds the inter-hunk-and-trailing tail of a real-world long edit (replace_all, 15-line file)", async () => {
    // Regression test for a real-world case: a short story where the same 3-char
    // string appears at line 1 and line 3, and replace_all rewrites both. The
    // 12 trailing context lines (4-15) used to be rendered verbatim in the
    // legacy implementation; the unified head+...+tail rule must fold them to
    // 4 + "..." + 4. The 1-line blank between the two hunks is also part of
    // the inter-hunk block and renders without an elision marker (≤ 2*contextLines).
    await withWorkspace(async (root, registry) => {
      const lines: string[] = [
        "时光旅人",
        "",
        "时光旅人。",
        "我叫苏晚，今年二十八岁，是一个普通的图书管理员。",
        "每天的工作就是整理书籍，帮读者查找资料。这样的生活平淡而安稳，像一潭静水。直到那个雨夜，一切都改变了。",
        "那天晚上，我正准备下班关门，忽然发现门口有一封信。信是白色的，没有信封，只有折叠整齐的信纸，上面用漂亮的手写字体写着我的名字。我从未见过这样的信，没有寄件人地址，没有邮戳，没有任何能表明它来源的标记。它就那样静静地躺在图书馆门口的台阶上，被雨水打湿了一角，却奇迹般地没有完全浸透。",
        "带着满心的疑虑，我小心翼翼地打开信，里面只有短短几行字：\"苏晚小姐，我们诚邀您参加一场特殊的聚会。时间：明晚子夜时分。地点：城南废弃的钟楼。请务必准时出席，届时您将获得改变一生的机会。--时光的守护者\"",
        "",
        "我环顾四周，图书馆早已空无一人。窗外的雨越下越大，雷声隆隆。",
        "",
        "我反复读着信上的内容，试图找出一些端倪。但信上没有任何其他线索，纸质摸起来也普普通通。我开始怀疑这是一场恶作剧。",
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
          old_string: "时光旅人",
          new_string: "时光旅人：觉皇之路",
          replace_all: true,
        },
        undefined,
        undefined,
        { cwd: root },
      );
      const diff = result.details?.diff ?? "";
      // Both hunks are present
      expect(diff).toContain("- 1|时光旅人");
      expect(diff).toContain("+ 1|时光旅人：觉皇之路");
      expect(diff).toContain("- 3|时光旅人。");
      expect(diff).toContain("+ 3|时光旅人：觉皇之路。");
      // The 1-line blank between the two hunks is rendered (no elision).
      expect(diff).toContain("  2|");
      // The 12-line trailing block must fold: head 4 (lines 4-7), "...", tail 4 (lines 12-15).
      expect(diff).toContain("...");
      expect(diff).toContain("我叫苏晚"); // head-1
      expect(diff).toContain("带着满心"); // head-4
      // Lines 8-11 are in the elided middle and must not appear.
      expect(diff).not.toContain("我环顾四周");
      expect(diff).not.toContain("我反复读着");
      // Last 4 lines are kept.
      expect(diff).toContain("第二天是周六");
      expect(diff).toContain("子夜时分");
    });
  });
});
