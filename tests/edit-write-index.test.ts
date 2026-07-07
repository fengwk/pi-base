import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import piBaseExtension from "../index.js";
import { registerEditTool } from "../src/edit.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

describe("edit/write flow", () => {
  it("adds retry guidance to edit argument validation failures", () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const editTool = registry.getTool("edit");

    let message = "";
    try {
      editTool.prepareArguments({ workdir: ".", path: "test.ts", oldString: "a" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Validation failed for tool \"edit\":");
    expect(message).toContain("newString");
    expect(message).toContain("Adjust the input parameters and re-run the `edit` command.");
  });

  it("write returns a simple success message", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/new.ts", content: "export const demo = 1;\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    const text = getText(result);
    expect(text).toContain("Created src/new.ts successfully.");
    expect(text).not.toContain("[src/new.ts#");
  });

  it("write preserves an existing BOM while overwriting content", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src/example.ts");
    await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("alpha\n", "utf8")]));
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/example.ts", content: "beta\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    const written = await readFile(file);
    expect(written[0]).toBe(0xef);
    expect(written[1]).toBe(0xbb);
    expect(written[2]).toBe(0xbf);
    expect(written.subarray(3).toString("utf8")).toBe("beta\n");
  });

  it("write preserves existing utf-16le encoding and BOM while overwriting content", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src/example.txt");
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("alpha\n", "utf16le")]));
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/example.txt", content: "beta\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    const written = await readFile(file);
    expect(written[0]).toBe(0xff);
    expect(written[1]).toBe(0xfe);
    expect(written.subarray(2).toString("utf16le")).toBe("beta\n");
  });

  it("write rejects missing content when schema validation is bypassed", async () => {
    // Intent: direct execute calls should not treat a missing content argument as
    // an intentional empty-file overwrite.
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/new.ts" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("content is required");
  });

  it("write rejects text that cannot be represented in the existing legacy encoding", async () => {
    // Intent: legacy encoded files must not silently replace unrepresentable
    // characters with '?' while reporting the original text as written.
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src/legacy.txt");
    const originalBytes = Buffer.from("café\nolé\n", "latin1");
    await writeFile(file, originalBytes);
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/legacy.txt", content: "snow 漢字\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("cannot be represented");
    expect(await readFile(file)).toEqual(originalBytes);
  });

  it("edits a file using oldString/newString", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/new.ts", "export const demo = 1;\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const editResult = await registry.getTool("edit").execute(
      "2",
      { workdir: ".", path: "src/new.ts", oldString: "export const demo = 1;", newString: "export const demo = 2;" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(editResult.isError).not.toBe(true);
    expect(getText(editResult)).toContain("Edited src/new.ts successfully.");
    expect(await readFile(join(root, "src/new.ts"), "utf8")).toBe("export const demo = 2;\n");
  });

  it("rejects edit when oldString is not found", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "nonexistent", newString: "replacement" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Could not find oldString");
  });

  it("rejects edit when oldString matches multiple times", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nalpha\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "alpha", newString: "beta" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Found 2 exact matches");
  });

  it("rejects edit when oldString has overlapping matches", async () => {
    // Intent: uniqueness checks must count overlapping occurrences too, otherwise
    // `aaa` with oldString `aa` looks unique and edits the wrong span.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "aaa\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "aa", newString: "b" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Found 2 exact matches");
    expect(await readFile(join(root, "src/example.ts"), "utf8")).toBe("aaa\n");
  });

  it("supports replaceAll for multiple matches", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nalpha\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "alpha", newString: "beta", replaceAll: true },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "src/example.ts"), "utf8")).toBe("beta\nbeta\n");
  });

  it("rejects replaceAll when matches overlap", async () => {
    // Intent: overlapping replaceAll cannot be applied as independent exact
    // replacements, so the tool should fail instead of producing order-dependent output.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "aaa\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "aa", newString: "b", replaceAll: true },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("overlapping exact matches");
    expect(await readFile(join(root, "src/example.ts"), "utf8")).toBe("aaa\n");
  });

  it("rejects identical oldString and newString", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "alpha", newString: "alpha" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("identical");
  });

  it("rejects no-op edits that differ only by line-ending spelling", async () => {
    // Intent: the edit tool shows a normalized text view, so CRLF vs LF spelling
    // alone must not be reported as a successful content change.
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src/example.ts");
    await writeFile(file, "alpha\r\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "alpha\r\n", newString: "alpha\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("No changes to apply");
    expect(await readFile(file, "utf8")).toBe("alpha\r\n");
  });

  it("rejects empty oldString", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "", newString: "beta" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("oldString must not be empty");
  });

  it("rejects missing newString when schema validation is bypassed", async () => {
    // Intent: direct execute calls should not treat a missing newString argument
    // as an intentional deletion.
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "alpha" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("newString is required");
    expect(await readFile(join(root, "src/example.ts"), "utf8")).toBe("alpha\n");
  });

  it("edits the current file contents without cross-call stale-read protection", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\nbeta\n");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "alpha", newString: "gamma" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "src/example.ts"), "utf8")).toBe("gamma\nbeta\n");
  });

  it("preserves CRLF line endings during edit", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src/example.ts");
    await writeFile(file, "alpha\r\nbeta\r\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "beta", newString: "gamma" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    expect(await readFile(file, "utf8")).toBe("alpha\r\ngamma\r\n");
  });

  it("preserves CR line endings during multiline edit", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src/example.ts");
    await writeFile(file, "alpha\rbeta\rgamma\r", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "alpha\nbeta", newString: "left\nright" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    expect(await readFile(file, "utf8")).toBe("left\rright\rgamma\r");
  });

  it("preserves matched mixed line endings for replaced newlines", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src/example.ts");
    await writeFile(file, "alpha\r\nbeta\rgamma", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "alpha\nbeta", newString: "left\nright" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    expect(await readFile(file, "utf8")).toBe("left\r\nright\rgamma");
  });

  it("uses LF for ambiguous inserted newlines in mixed-ending files", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src/example.ts");
    await writeFile(file, "head\r\nmiddle\rtail", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "middle", newString: "left\nright" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    expect(await readFile(file, "utf8")).toBe("head\r\nleft\nright\rtail");
  });

  it("can add and remove a final newline through the normalized LF view", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const noNewlineFile = join(root, "src/no-newline.txt");
    const withNewlineFile = join(root, "src/with-newline.txt");
    await writeFile(noNewlineFile, "tail", "utf8");
    await writeFile(withNewlineFile, "tail\n", "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const addNewline = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/no-newline.txt", oldString: "tail", newString: "tail\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(addNewline.isError).not.toBe(true);
    expect(await readFile(noNewlineFile, "utf8")).toBe("tail\n");

    const removeNewline = await registry.getTool("edit").execute(
      "2",
      { workdir: ".", path: "src/with-newline.txt", oldString: "tail\n", newString: "tail" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(removeNewline.isError).not.toBe(true);
    expect(await readFile(withNewlineFile, "utf8")).toBe("tail");
  });

  it("preserves BOM during edit", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src/example.ts");
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(file, Buffer.concat([bom, Buffer.from("alpha\nbeta\n", "utf8")]));
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.ts", oldString: "alpha", newString: "gamma" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    const written = await readFile(file);
    expect(written[0]).toBe(0xef);
    expect(written[1]).toBe(0xbb);
    expect(written[2]).toBe(0xbf);
    expect(written.subarray(3).toString("utf8")).toBe("gamma\nbeta\n");
  });

  it("preserves utf-16le encoding during edit", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src/example.txt");
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("alpha\nbeta\n", "utf16le")]));
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/example.txt", oldString: "alpha", newString: "gamma" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).not.toBe(true);
    const written = await readFile(file);
    expect(written[0]).toBe(0xff);
    expect(written[1]).toBe(0xfe);
    expect(written.subarray(2).toString("utf16le")).toBe("gamma\nbeta\n");
  });

  it("edit rejects text that cannot be represented in the existing legacy encoding", async () => {
    // Intent: edit previews and written bytes must stay consistent for legacy
    // encodings by refusing lossy replacement before writing.
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src/legacy.txt");
    const originalBytes = Buffer.from("café\n", "latin1");
    await writeFile(file, originalBytes);
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("edit").execute(
      "1",
      { workdir: ".", path: "src/legacy.txt", oldString: "café", newString: "漢字" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("cannot be represented");
    expect(await readFile(file)).toEqual(originalBytes);
  });

  it("edit reports missing path", async () => {
    const registry = createToolRegistry();
    const tool = registerEditTool(registry.pi as any);
    const result = await tool.execute("1", { workdir: ".", oldString: "a", newString: "b" }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("path is required");
  });
});
