import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { decodeTextFile, detectTextFileEncoding } from "../src/text-codec.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

function tools() {
  const registry = createToolRegistry();
  piBaseExtension(registry.pi as never);
  return registry;
}

async function run(registry: ReturnType<typeof tools>, name: string, cwd: string, args: Record<string, unknown>) {
  return registry.getTool(name).execute("encoding", { path: "sample.txt", ...args }, undefined, undefined, { cwd });
}

describe("text encoding safety", () => {
  it("prefers validated UTF-8 over statistical encoding guesses", () => {
    // Intent: common UTF-8 files must not depend on detector confidence.
    const bytes = Buffer.from("中文 café\n", "utf8");
    expect(detectTextFileEncoding(bytes)).toMatchObject({ encoding: "utf-8", source: "utf8" });
    expect(decodeTextFile(bytes)?.text).toBe("中文 café\n");
  });

  it.each([
    { encoding: "big5", content: "中文\nstate=old\n", ambiguous: true },
    { encoding: "windows-1252", content: "café\nstate=old\n" },
    { encoding: "gbk", content: "这是一个中文文件，用于测试旧编码识别。\nstate=old\n" },
    { encoding: "big5", content: "這是一份繁體中文測試文件，包含資料處理、檔案編輯與系統設定。\n第二行內容保持不變。\nstate=old\n" },
    { encoding: "shift_jis", content: "これは日本語のテキストファイルです。文字コードの自動判定と編集を確認します。\n変更しない行を保存します。\nstate=old\n" },
    { encoding: "utf-16le", content: "alpha beta gamma delta\n中文\nstate=old\n" },
    { encoding: "utf-16be", content: "alpha beta gamma delta\n中文\nstate=old\n" },
  ])("retains automatic read/edit/write for $encoding without new arguments", async ({ encoding, content, ambiguous }) => {
    // Intent: do not ban inferred encodings; ASCII changes must preserve the existing non-ASCII bytes.
    const root = await createTempWorkspace();
    const file = join(root, "sample.txt");
    await writeFile(file, iconv.encode(content, encoding));
    const registry = tools();
    const read = await run(registry, "read", root, {});
    expect(read.isError).not.toBe(true);
    if (!ambiguous) expect(getText(read)).toContain(content.split("\n")[0]);
    expect(getText(read)).not.toContain("encoding:");
    const edit = await run(registry, "edit", root, { edits: [{ old_string: "state=old", new_string: "state=new" }] });
    expect(edit.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(iconv.encode(content.replace("state=old", "state=new"), encoding));
    const write = await run(registry, "write", root, { content: decodeTextFile(await readFile(file))!.text.replace("state=new", "state=done") });
    expect(write.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(iconv.encode(content.replace("state=old", "state=done"), encoding));
    for (const name of ["read", "edit", "write"]) expect(registry.getTool(name).parameters.properties).not.toHaveProperty("encoding");
  });

  it.each(["edit", "write"])("rejects provably lossy original decoding before %s", async (name) => {
    // Intent: malformed UTF-8 after a BOM must not become U+FFFD bytes outside the intended change.
    const root = await createTempWorkspace();
    const file = join(root, "sample.txt");
    const before = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("alpha\n"), Buffer.from([0xff])]);
    await writeFile(file, before);
    const args = name === "edit" ? { edits: [{ old_string: "alpha", new_string: "beta" }] } : { content: "beta\n" };
    const result = await run(tools(), name, root, args);
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("original bytes");
    expect(await readFile(file)).toEqual(before);
  });

  it("preserves a legitimate UTF-8 replacement character while editing", async () => {
    // Intent: byte validation must distinguish actual malformed bytes from intentional U+FFFD text.
    const root = await createTempWorkspace();
    const file = join(root, "sample.txt");
    await writeFile(file, Buffer.from("alpha\n\uFFFD\n", "utf8"));
    const edit = await run(tools(), "edit", root, { edits: [{ old_string: "alpha", new_string: "beta" }] });
    expect(edit.isError).not.toBe(true);
    expect(await readFile(file)).toEqual(Buffer.from("beta\n\uFFFD\n", "utf8"));
  });
});
