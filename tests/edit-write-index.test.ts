import { describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { registerEditTool } from "../src/edit.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

function extractAnchor(line: string): string {
  const match = line.match(/(?:\+|\||-)\s+(\d+:[0-9a-f]{3})\|/i) ?? line.match(/^(\d+:[0-9a-f]{3})\|/i);
  if (!match) throw new Error(`No anchor found in line: ${line}`);
  return match[1]!;
}

async function withTempGlobalPiBaseConfig<T>(content: unknown, run: (root: string) => Promise<T> | T): Promise<T> {
  const previous = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  const root = await createTempWorkspace();
  const globalPath = join(root, "global-pi-base.json");
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalPath;
  try {
    await writeFile(globalPath, JSON.stringify(content), "utf8");
    return await run(root);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
    } else {
      process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previous;
    }
  }
}

describe("edit/write flow", () => {
  it("write returns anchors that can be used by edit", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const writeResult = await registry.getTool("write").execute("1", { path: "src/new.ts", content: "export const demo = 1;\n" }, undefined, undefined, { cwd: root });
    const writeText = getText(writeResult);
    expect(writeText).toContain("Created src/new.ts.");
    expect(writeText).toContain("Review the written file content below.");
    expect(writeText).toContain("LINE:HASH anchors for follow-up edits.");
    expect(writeText).not.toContain("status:");
    expect(writeText).not.toContain("writeState:");
    const anchor = writeText.split("\n").find((line) => line.includes("|export const demo = 1;"))!.split("|")[0]!;
    const editResult = await registry.getTool("edit").execute("2", { path: "src/new.ts", edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "export const demo = 2;" } }] }, undefined, undefined, { cwd: root });
    expect(editResult.isError).not.toBe(true);
    const written = await readFile(join(root, "src/new.ts"), "utf8");
    expect(written).toContain("export const demo = 2;");
  });

  it("reports overwrite success in natural language and keeps anchors usable", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    await registry.getTool("write").execute("1", { path: "src/new.ts", content: "export const demo = 1;\n" }, undefined, undefined, { cwd: root });
    const overwriteResult = await registry.getTool("write").execute("2", { path: "src/new.ts", content: "export const demo = 3;\n" }, undefined, undefined, { cwd: root });
    const overwriteText = getText(overwriteResult);
    expect(overwriteText).toContain("Overwrote src/new.ts.");
    expect(overwriteText).toContain("Review the written file content below.");
    expect(overwriteText).toContain("LINE:HASH anchors for follow-up edits.");
    const anchor = overwriteText.split("\n").find((line) => line.includes("|export const demo = 3;"))!.split("|")[0]!;
    const editResult = await registry.getTool("edit").execute("3", { path: "src/new.ts", edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "export const demo = 4;" } }] }, undefined, undefined, { cwd: root });
    expect(editResult.isError).not.toBe(true);
  });

  it("renders full write payload previews even when the tool is collapsed", () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const tool = registry.getTool("write");
    const component = tool.renderCall(
      { path: "src/example.ts", content: "line-1\nline-2\nline-3\nline-4\nline-5\nline-6\nline-7\nline-8\nline-9\nline-10\nline-11" },
      {} as any,
      { lastComponent: undefined, expanded: false },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("line-11");
    expect(rendered).not.toContain("... (");
  });

  it("keeps completed write call previews visible when collapsed", async () => {
    await withTempGlobalPiBaseConfig({}, async () => {
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);
      const tool = registry.getTool("write");
      const component = tool.renderCall(
        { path: "src/example.ts", content: "alpha\nbeta\ngamma" },
        {} as any,
        { lastComponent: undefined, executionStarted: true, argsComplete: true, isPartial: false, expanded: false, isError: false },
      ) as any;
      const rendered = component.render(200).join("\n");
      expect(rendered).toContain("alpha");
      expect(rendered).toContain("beta");
      expect(rendered).toContain("gamma");
      expect(rendered).not.toContain("lines prepared.");
      expect(rendered).not.toContain("Expand to inspect the original write payload.");
    });
  });

  it("keeps the completed write call preview available when the tool is expanded", () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const tool = registry.getTool("write");
    const component = tool.renderCall(
      { path: "src/example.ts", content: "alpha\nbeta\ngamma" },
      {} as any,
      { lastComponent: undefined, executionStarted: true, argsComplete: true, isPartial: false, expanded: true, isError: false },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("beta");
    expect(rendered).toContain("gamma");
  });

  it("allows follow-up edits using refreshed anchors from a prior edit result", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const readText = getText(readResult);
    const anchor = readText.split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const firstEdit = await registry.getTool("edit").execute("2", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "gamma" } }] }, undefined, undefined, { cwd: root });
    expect(firstEdit.isError).not.toBe(true);
    const refreshedLine = getText(firstEdit).split("\n").find((line) => line.includes("|gamma"))!;
    const refreshedAnchor = extractAnchor(refreshedLine);
    const secondEdit = await registry.getTool("edit").execute("3", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: refreshedAnchor, end_anchor: refreshedAnchor, new_text: "delta" } }] }, undefined, undefined, { cwd: root });
    expect(secondEdit.isError).not.toBe(true);
    const written = await readFile(join(root, "src/example.ts"), "utf8");
    expect(written).toContain("delta");
  });

  it("rejects stale anchors from before the last edit", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const oldAnchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const firstEdit = await registry.getTool("edit").execute("2", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: oldAnchor, end_anchor: oldAnchor, new_text: "gamma" } }] }, undefined, undefined, { cwd: root });
    expect(firstEdit.isError).not.toBe(true);
    const secondEdit = await registry.getTool("edit").execute("3", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: oldAnchor, end_anchor: oldAnchor, new_text: "delta" } }] }, undefined, undefined, { cwd: root });
    expect(secondEdit.isError).toBe(true);
    expect(getText(secondEdit)).toContain("The anchor no longer matches the current file");
    expect(getText(secondEdit)).toContain("Refreshed anchors near the failed region");
  });

  it("treats whitespace-only changes as stale anchor changes", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha  beta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|alpha  beta"))!.split("|")[0]!;
    await writeWorkspaceFile(root, "src/example.ts", "alpha beta\n");
    const result = await registry.getTool("edit").execute("2", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "gamma" } }] }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("The anchor no longer matches the current file");
  });

  it("visualizes leading whitespace in edit result diff", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "  old\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|  old"))!.split("|")[0]!;
    const result = await registry.getTool("edit").execute("2", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "  new" } }] }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    const text = getText(result);
    // Both removed and added lines should show their leading whitespace
    // as a sequence of `·` to make it visually distinct.
    expect(text).toMatch(/- +1:[0-9a-f]{3}\|··old/);
    expect(text).toMatch(/\+ +1:[0-9a-f]{3}\|··new/);
  });

  it("preserves request order for multiple insert_after operations on the same anchor", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|alpha"))!.split("|")[0]!;
    const result = await registry.getTool("edit").execute(
      "2",
      {
        path: "src/example.ts",
        edits: [
          { insert_after: { anchor, new_text: "one" } },
          { insert_after: { anchor, new_text: "two" } },
        ],
      },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    const written = await readFile(join(root, "src/example.ts"), "utf8");
    expect(written).toBe("alpha\none\ntwo\nbeta\n");
  });

  it("keeps insert_before before the anchor and insert_after after the anchor", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const result = await registry.getTool("edit").execute(
      "2",
      {
        path: "src/example.ts",
        edits: [
          { insert_before: { anchor, new_text: "before" } },
          { insert_after: { anchor, new_text: "after" } },
        ],
      },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    const written = await readFile(join(root, "src/example.ts"), "utf8");
    expect(written).toBe("alpha\nbefore\nbeta\nafter\n");
  });

  it("preserves request order for inserts that target the same physical boundary via adjacent anchors", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const lines = getText(readResult).split("\n");
    const alpha = lines.find((line) => line.includes("|alpha"))!.split("|")[0]!;
    const beta = lines.find((line) => line.includes("|beta"))!.split("|")[0]!;
    const result = await registry.getTool("edit").execute(
      "2",
      {
        path: "src/example.ts",
        edits: [
          { insert_after: { anchor: alpha, new_text: "after-alpha" } },
          { insert_before: { anchor: beta, new_text: "before-beta" } },
        ],
      },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    const written = await readFile(join(root, "src/example.ts"), "utf8");
    expect(written).toBe("alpha\nafter-alpha\nbefore-beta\nbeta\n");
  });

  it("rejects overlapping range edits before writing", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\ntwo\nthree\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const lines = getText(readResult).split("\n");
    const one = lines.find((line) => line.includes("|one"))!.split("|")[0]!;
    const two = lines.find((line) => line.includes("|two"))!.split("|")[0]!;
    const three = lines.find((line) => line.includes("|three"))!.split("|")[0]!;
    const result = await registry.getTool("edit").execute(
      "2",
      {
        path: "src/example.ts",
        edits: [
          { replace_lines: { start_anchor: one, end_anchor: two, new_text: "alpha" } },
          { delete_lines: { start_anchor: two, end_anchor: three } },
        ],
      },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Overlapping replace_lines/delete_lines edits are not allowed");
  });

  it("reports stale anchors without relocation", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\ntwo\n");
    const registry = createToolRegistry();
    const tool = registerEditTool(registry.pi as any, { wasReadInSession: () => true });
    const staleAnchor = "2:000";
    const result = await tool.execute("1", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: staleAnchor, end_anchor: staleAnchor, new_text: "three" } }] }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("The anchor no longer matches the current file");
    expect(getText(result)).not.toContain("2:000|");
  });

  it("reports no-op edits", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const result = await registry.getTool("edit").execute("2", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "beta" } }] }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("would not change the file");
  });

  it("supports insert_before", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const result = await registry.getTool("edit").execute("2", { path: "src/example.ts", edits: [{ insert_before: { anchor, new_text: "inserted" } }] }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    const written = await readFile(join(root, "src/example.ts"), "utf8");
    expect(written).toContain("alpha\ninserted\nbeta\n");
  });

  it("renders insert_before calls as contextual diff hunks", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const tool = registry.getTool("edit");
    const component = tool.renderCall(
      { path: "src/example.ts", edits: [{ insert_before: { anchor, new_text: "inserted" } }] },
      {} as any,
      { lastComponent: undefined, cwd: root },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("insert_before");
    expect(rendered).toContain("  1 alpha");
    expect(rendered).toContain("+  2 inserted");
    expect(rendered).toContain("  3 beta");
  });

  it("renders empty new_text in preview using the same semantics as execution", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const tool = registry.getTool("edit");
    const component = tool.renderCall(
      { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "" } }] },
      {} as any,
      { lastComponent: undefined, cwd: root },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("replace_lines");
    expect(rendered).toContain("-  2 beta");
    expect(rendered).toMatch(/^\+ +2\s*$/m);
  });

  it("formats edit calls for human review", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const tool = registry.getTool("edit");
    const component = tool.renderCall(
      {
        path: "src/example.ts",
        edits: [{ insert_after: { anchor, new_text: "first line\nsecond line" } }],
      },
      {} as any,
      { lastComponent: undefined, cwd: root },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("edit src/example.ts");
    expect(rendered).toContain(" 1 alpha");
    expect(rendered).toContain(" 2 beta");
    expect(rendered).toContain("+  3 first line");
    expect(rendered).toContain("+  4 second line");
    expect(rendered).not.toContain("| after");
  });

  it("keeps completed edit call previews visible when collapsed", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const tool = registry.getTool("edit");
    const component = tool.renderCall(
      { path: "src/example.ts", edits: [{ insert_after: { anchor, new_text: "first line\nsecond line" } }] },
      {} as any,
      { lastComponent: undefined, cwd: root, executionStarted: true, argsComplete: true, isPartial: false, expanded: false, isError: false },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("+  3 first line");
    expect(rendered).toContain("+  4 second line");
    expect(rendered).not.toContain("requested operation.");
    expect(rendered).not.toContain("Expand to inspect the original request preview.");
  });

  it("keeps the completed edit call preview available when the tool is expanded", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const tool = registry.getTool("edit");
    const component = tool.renderCall(
      { path: "src/example.ts", edits: [{ insert_after: { anchor, new_text: "first line\nsecond line" } }] },
      {} as any,
      { lastComponent: undefined, cwd: root, executionStarted: true, argsComplete: true, isPartial: false, expanded: true, isError: false },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("+  3 first line");
    expect(rendered).toContain("+  4 second line");
  });

  it("freezes edit call previews so post-edit rerenders do not read the live file", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "docs/seedance.md", "sdrama video seedance --file shot.json\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "docs/seedance.md" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|sdrama video seedance --file shot.json"))!.split("|")[0]!;
    const args = {
      path: "docs/seedance.md",
      edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "sdrama video seedance dsl shot.json" } }],
    };
    const tool = registry.getTool("edit");
    const component = tool.renderCall(args, {} as any, { lastComponent: undefined, cwd: root }) as any;

    const firstRender = component.render(200).join("\n");
    expect(firstRender).toContain("-  1 sdrama video seedance --file shot.json");
    expect(firstRender).toContain("+  1 sdrama video seedance dsl shot.json");

    await writeWorkspaceFile(root, "docs/seedance.md", "sdrama video seedance dsl shot.json\n");
    const rerenderedComponent = tool.renderCall(args, {} as any, { lastComponent: component, cwd: root }) as any;
    const rerender = rerenderedComponent.render(200).join("\n");

    expect(rerenderedComponent).toBe(component);
    expect(rerender).toContain("-  1 sdrama video seedance --file shot.json");
    expect(rerender).toContain("+  1 sdrama video seedance dsl shot.json");
    expect(rerender).not.toContain("-  1 sdrama video seedance dsl shot.json");
  });

  it("uses the execution snapshot for completed edit call previews when no component snapshot survives", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "docs/seedance.md", "sdrama video seedance --file shot.json\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "docs/seedance.md" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|sdrama video seedance --file shot.json"))!.split("|")[0]!;
    const args = {
      path: "docs/seedance.md",
      edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "sdrama video seedance dsl shot.json" } }],
    };
    const tool = registry.getTool("edit");

    const result = await tool.execute("2", args, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    const component = tool.renderCall(args, {} as any, { lastComponent: undefined, cwd: root }) as any;
    const rendered = component.render(200).join("\n");

    expect(rendered).toContain("-  1 sdrama video seedance --file shot.json");
    expect(rendered).toContain("+  1 sdrama video seedance dsl shot.json");
    expect(rendered).not.toContain("-  1 sdrama video seedance dsl shot.json");
  });

  it("uses themed titles in edit call rendering", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const tool = registry.getTool("edit");
    const component = tool.renderCall(
      { path: "src/example.ts", edits: [{ insert_after: { anchor, new_text: "first line" } }] },
      { fg: (_color: string, text: string) => `<${text}>`, bold: (text: string) => `**${text}**` } as any,
      { lastComponent: undefined, cwd: root },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("<**edit**>");
  });

  it("visualizes leading whitespace in preview hunks", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "  old\nnext\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|  old"))!.split("|")[0]!;
    const tool = registry.getTool("edit");
    const component = tool.renderCall(
      { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "  new" } }] },
      {} as any,
      { lastComponent: undefined, cwd: root },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("··old");
    expect(rendered).toContain("··new");
  });

  it("falls back to summary rendering when preview cannot be built", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    const tool = registerEditTool(registry.pi as any, {
      wasReadInSession: () => true,
      getCachedLines: () => ["alpha", "beta", ""],
    });
    const component = tool.renderCall(
      { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: "bad", end_anchor: "bad", new_text: "gamma" } }] },
      {} as any,
      { lastComponent: undefined },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("replace_lines");
    expect(rendered).toContain("invalid anchor in replace_lines");
  });

  it("fallback summary treats empty new_text as one blank line", async () => {
    const registry = createToolRegistry();
    const tool = registerEditTool(registry.pi as any, {
      wasReadInSession: () => true,
      getCachedLines: () => undefined,
    });
    const component = tool.renderCall(
      { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: "2:abc", end_anchor: "2:abc", new_text: "" } }] },
      {} as any,
      { lastComponent: undefined },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("replace_lines");
    expect(rendered).not.toContain("[empty]");
    expect(rendered).toMatch(/^\+\s*$/m);
  });

  it("shows unknown edit marker inside preview mode when a snapshot is available", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const tool = registry.getTool("edit");
    const component = tool.renderCall(
      { path: "src/example.ts", edits: [{ unsupported: true }] },
      {} as any,
      { lastComponent: undefined, cwd: root },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("? unknown_edit");
  });

  it("rejects edit items that mix multiple operation keys", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const result = await registry.getTool("edit").execute(
      "2",
      {
        path: "src/example.ts",
        edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "gamma" }, delete_lines: { start_anchor: anchor, end_anchor: anchor } }],
      },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Each edit item must contain exactly one operation");
  });

  it("formats replace and delete calls in diff-like style", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\ntwo\nthree\nfour\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const readLines = getText(readResult).split("\n");
    const start = readLines.find((line) => line.includes("|two"))!.split("|")[0]!;
    const end = readLines.find((line) => line.includes("|three"))!.split("|")[0]!;
    const tool = registry.getTool("edit");
    const component = tool.renderCall(
      {
        path: "src/example.ts",
        edits: [
          { replace_lines: { start_anchor: start, end_anchor: end, new_text: "merged" } },
        ],
      },
      {} as any,
      { lastComponent: undefined, cwd: root },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("-  2 two");
    expect(rendered).toContain("-  3 three");
    expect(rendered).toContain("+  2 merged");
    expect(rendered).not.toContain("- range");
  });

  it("renders delete_lines calls as contextual diff hunks", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "one\ntwo\nthree\nfour\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const readLines = getText(readResult).split("\n");
    const start = readLines.find((line) => line.includes("|two"))!.split("|")[0]!;
    const end = readLines.find((line) => line.includes("|three"))!.split("|")[0]!;
    const tool = registry.getTool("edit");
    const component = tool.renderCall(
      { path: "src/example.ts", edits: [{ delete_lines: { start_anchor: start, end_anchor: end } }] },
      {} as any,
      { lastComponent: undefined, cwd: root },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("delete_lines");
    expect(rendered).toContain("  1 one");
    expect(rendered).toContain("-  2 two");
    expect(rendered).toContain("-  3 three");
    expect(rendered).toContain("  2 four");
  });

  it("falls back to unknown edit marker for unsupported preview items", async () => {
    const registry = createToolRegistry();
    const tool = registerEditTool(registry.pi as any, { wasReadInSession: () => true });
    const component = tool.renderCall(
      { path: "src/example.ts", edits: [{ unsupported: true }] },
      {} as any,
      { lastComponent: undefined, cwd: process.cwd() },
    ) as any;
    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("? unknown_edit");
  });

  it("returns english success text and diff with refreshed anchors after edit", async () => {
    const root = await createTempWorkspace();
    // `alpha\nbeta\n` is the raw 3-element split ["alpha", "beta", ""].
    // The diff library folds the trailing \n into the preceding
    // part, so it shows 2 lines in the changed region: alpha
    // (unchanged) and beta→gamma. The implicit trailing empty
    // (line 3 in the file) is a file-structure fact shown by
    // read/write/edit but is not emitted as its own diff part.
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const result = await registry.getTool("edit").execute("2", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "gamma" } }] }, undefined, undefined, { cwd: root });
    const text = getText(result);
    expect(text).toContain("Edit applied to src/example.ts.");
    expect(text).toContain("Review the diff below.");
    expect(text).toContain("Lines prefixed with \"+\" or \"|\" carry the current LINE:HASH anchors");
    expect(text).toContain("| 1:");
    expect(text).toContain("- 2:");
    expect(text).toContain("+ 2:");
    expect(text).toContain("|alpha");
    expect(text).toContain("|gamma");
    // The diff's `lineNumWidth` is 1.
    expect(text).not.toMatch(/^\| {2,}\d/);
    expect(text).not.toMatch(/^[+-] {2,}\d/);
    expect(text).not.toContain("status:");
    expect(text).not.toContain("updatedAnchors:");
    expect(text).not.toContain("diff:");
  });

  it("returns only changed regions plus context in edit result diffs", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", [
      "line-1",
      "line-2",
      "line-3",
      "line-4",
      "line-5",
      "line-6",
      "line-7",
      "line-8",
      "line-9",
      "line-10",
      "line-11",
      "line-12",
    ].join("\n"));
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const lines = getText(readResult).split("\n");
    const line2 = lines.find((line) => line.includes("|line-2"))!.split("|")[0]!;
    const line10 = lines.find((line) => line.includes("|line-10"))!.split("|")[0]!;
    const result = await registry.getTool("edit").execute(
      "2",
      {
        path: "src/example.ts",
        edits: [
          { replace_lines: { start_anchor: line2, end_anchor: line2, new_text: "line-2-updated" } },
          { replace_lines: { start_anchor: line10, end_anchor: line10, new_text: "line-10-updated" } },
        ],
      },
      undefined,
      undefined,
      { cwd: root },
    );
    const text = getText(result);
    expect(text).toContain("|line-2-updated");
    expect(text).toContain("|line-10-updated");
    expect(text).toContain("...");
    expect(text).not.toContain("|line-6");
  });

  it("returns an empty-file anchor when edits remove all content", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|alpha"))!.split("|")[0]!;
    const deleteResult = await registry.getTool("edit").execute("2", { path: "src/example.ts", edits: [{ delete_lines: { start_anchor: anchor, end_anchor: anchor } }] }, undefined, undefined, { cwd: root });
    const emptyAnchorLine = getText(deleteResult).split("\n").find((line) => /(?:\||\+)\s*1:[0-9a-f]{3}\|$/.test(line));
    const emptyAnchor = emptyAnchorLine ? extractAnchor(emptyAnchorLine) : undefined;
    expect(emptyAnchor).toBeTruthy();

    const refill = await registry.getTool("edit").execute("3", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: emptyAnchor!, end_anchor: emptyAnchor!, new_text: "beta" } }] }, undefined, undefined, { cwd: root });
    expect(refill.isError).not.toBe(true);
    const written = await readFile(join(root, "src/example.ts"), "utf8");
    expect(written).toContain("beta");
  });

  it("uses default render shell so edit rows keep standard success background", async () => {
    const registry = createToolRegistry();
    const tool = registerEditTool(registry.pi as any, { wasReadInSession: () => true });
    expect(tool.renderShell).toBe("default");
  });

  it("requires fresh anchors before editing an unread file", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    const tool = registerEditTool(registry.pi as any, { wasReadInSession: () => false });
    const result = await tool.execute("1", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: "2:abc", end_anchor: "2:abc", new_text: "gamma" } }] }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Fresh anchors are required");
  });

  it("supports delete_lines", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\ngamma\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const lines = getText(readResult).split("\n");
    const start = lines.find((line) => line.includes("|beta"))!.split("|")[0]!;
    const end = lines.find((line) => line.includes("|gamma"))!.split("|")[0]!;
    const result = await registry.getTool("edit").execute("2", { path: "src/example.ts", edits: [{ delete_lines: { start_anchor: start, end_anchor: end } }] }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    const written = await readFile(join(root, "src/example.ts"), "utf8");
    expect(written).toBe("alpha\n");
  });

  it("preserves pure carriage-return line endings", async () => {
    const root = await createTempWorkspace();
    const file = join(root, "src/example.ts");
    await writeWorkspaceFile(root, "src/example.ts", "placeholder\n");
    await writeFile(file, "alpha\rbeta\r", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const result = await registry.getTool("edit").execute("2", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "gamma" } }] }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    const written = await readFile(file, "utf8");
    expect(written).toBe("alpha\rgamma\r");
  });

  it("rejects mixed line endings instead of silently rewriting the file", async () => {
    const root = await createTempWorkspace();
    const file = join(root, "src/example.ts");
    await writeWorkspaceFile(root, "src/example.ts", "placeholder\n");
    await writeFile(file, "alpha\r\nbeta\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const result = await registry.getTool("edit").execute("2", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "gamma" } }] }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Mixed line endings are not supported");
    const written = await readFile(file, "utf8");
    expect(written).toBe("alpha\r\nbeta\n");
  });

  it("surfaces invalid edit ranges", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    const tool = registerEditTool(registry.pi as any, { wasReadInSession: () => true });
    const result = await tool.execute("1", { path: "src/example.ts", edits: [{ replace_lines: { start_anchor: "2:000", end_anchor: "1:000", new_text: "x" } }] }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("replace_lines requires start_anchor line <= end_anchor line");
  });

  it("edit reports missing path", async () => {
    const registry = createToolRegistry();
    const tool = registerEditTool(registry.pi as any, { wasReadInSession: () => true });
    const result = await tool.execute("1", { edits: [] }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("path is required");
  });

  it("write reports missing path", async () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("write").execute("1", { content: "x" }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("path is required");
  });

  it("write honors cancellation before mutating disk", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const controller = new AbortController();
    controller.abort();
    const result = await registry.getTool("write").execute("1", { path: "src/cancelled.txt", content: "x" }, controller.signal, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Operation aborted");
  });

  it("write truncates huge outputs", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const content = Array.from({ length: 2505 }, (_, index) => `line-${index}`).join("\n");
    const result = await registry.getTool("write").execute("1", { path: "src/huge.txt", content }, undefined, undefined, { cwd: root });
    expect(getText(result)).toContain("The tool call succeeded but the output was truncated");
    const outputPath = result.details?.truncation?.outputPath;
    expect(outputPath).toBeTruthy();
    const saved = await readFile(outputPath, "utf8");
    expect(saved).toContain("2504:");
  });

  it("write truncates oversized text output by bytes", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const content = `${"x".repeat(60 * 1024)}\n`;
    const result = await registry.getTool("write").execute("1", { path: "src/oversized.txt", content }, undefined, undefined, { cwd: root });
    expect(getText(result)).toContain("bytes truncated");
    const outputPath = result.details?.truncation?.outputPath;
    expect(outputPath).toBeTruthy();
  });

  it("write preserves the implicit empty line produced by a trailing newline (fact display)", async () => {
    // `read` is a fact-display tool: it shows the file as it is.
    // `alpha\nbeta\n` splits into 3 elements: ["alpha", "beta", ""].
    // Both `write` and `read` must show the same 3 lines so the
    // agent and the human see identical facts.
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const writeResult = await registry.getTool("write").execute("1", { path: "src/trailing.ts", content: "alpha\nbeta\n" }, undefined, undefined, { cwd: root });
    const writeText = getText(writeResult);
    expect(writeText).toMatch(/^1:[0-9a-f]{3}\|alpha$/m);
    expect(writeText).toMatch(/^2:[0-9a-f]{3}\|beta$/m);
    // The implicit empty line is shown as `3:hash|` so the agent
    // and human both know the file ends with a newline.
    expect(writeText).toMatch(/^3:[0-9a-f]{3}\|$/m);
    const readResult = await registry.getTool("read").execute("2", { path: "src/trailing.ts" }, undefined, undefined, { cwd: root });
    expect(getText(readResult)).toContain("totalLines: 3");
  });

  it("edit follow-up diff uses the file's actual line numbers (3 for alpha\\nbeta\\n)", async () => {
    // `alpha\nbeta\n` is a 3-element split. The diff library folds
    // the trailing \n into the preceding part, so the diff shows
    // lines 1 and 2 in the changed region. Line 3 (the implicit
    // empty) is file structure, not emitted as a separate diff part.
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    await registry.getTool("write").execute("1", { path: "src/edit-trailing.ts", content: "alpha\nbeta\n" }, undefined, undefined, { cwd: root });
    const readResult = await registry.getTool("read").execute("2", { path: "src/edit-trailing.ts" }, undefined, undefined, { cwd: root });
    const anchor = getText(readResult).split("\n").find((line) => line.includes("|beta"))!.split("|")[0]!;
    const editResult = await registry.getTool("edit").execute("3", { path: "src/edit-trailing.ts", edits: [{ replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "gamma" } }] }, undefined, undefined, { cwd: root });
    expect(editResult.isError).not.toBe(true);
    const text = getText(editResult);
    expect(text).toMatch(/^\| 1:[0-9a-f]{3}\|alpha$/m);
    // "beta" is removed from line 2; "gamma" is added at line 2.
    expect(text).toMatch(/^- 2:[0-9a-f]{3}\|beta$/m);
    expect(text).toMatch(/^\+ 2:[0-9a-f]{3}\|gamma$/m);
  });
});
