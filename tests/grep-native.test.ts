import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import iconv from "iconv-lite";
import { afterEach, describe, expect, it, vi } from "vitest";
import piBaseExtension from "../index.js";
import { executeGrep } from "../src/grep-core.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

const fakeToolState = vi.hoisted(() => ({ rgPath: "", acquisitionDelayMs: 0 }));

vi.mock("../src/internal/pi-coding-agent-utils.js", () => ({
  ensureTool: vi.fn(async (tool: string, _silent?: boolean, signal?: AbortSignal) => {
    if (fakeToolState.acquisitionDelayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, fakeToolState.acquisitionDelayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("Operation aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (tool !== "rg" || !fakeToolState.rgPath) return undefined;
    return fakeToolState.rgPath;
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  fakeToolState.rgPath = "";
  fakeToolState.acquisitionDelayMs = 0;
  delete process.env.PI_BASE_FAKE_RG_MODE;
  delete process.env.PI_BASE_FAKE_RG_FILE;
  delete process.env.PI_BASE_FAKE_RG_TEXT;
  delete process.env.PI_BASE_FAKE_RG_COUNT;
  delete process.env.PI_BASE_FAKE_RG_NO_LINES;
  delete process.env.PI_BASE_FAKE_RG_REQUIRE_IGNORE_CASE;
});

async function installFakeRg(root: string): Promise<string> {
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const rgPath = join(binDir, "rg");
  await writeFile(
    rgPath,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("ripgrep 99.0.0");
  process.exit(0);
}
const mode = process.env.PI_BASE_FAKE_RG_MODE || "match";
if (process.env.PI_BASE_FAKE_RG_REQUIRE_IGNORE_CASE === "1" && !process.argv.includes("--ignore-case")) {
  console.error("missing --ignore-case");
  process.exit(2);
} else if (mode === "wait") {
  setInterval(() => {}, 1000);
} else if (mode === "error") {
  console.error("synthetic rg failure");
  process.exit(2);
} else if (mode === "no-match") {
  process.exit(1);
} else {
  if (mode === "invalid-json") console.log("{not-json");
  const file = process.env.PI_BASE_FAKE_RG_FILE;
  const lineText = process.env.PI_BASE_FAKE_RG_TEXT || "beta\\n";
  const count = Number(process.env.PI_BASE_FAKE_RG_COUNT || "1");
  const includeLines = process.env.PI_BASE_FAKE_RG_NO_LINES !== "1";
  const emit = (i) => {
    const data = { path: { text: file }, line_number: i + 2 };
    if (includeLines) data.lines = { text: lineText };
    console.log(JSON.stringify({ type: "match", data }));
  };
  if (mode === "paced-overflow") {
    for (let i = 0; i < count - 1; i++) emit(i);
    setTimeout(() => emit(count - 1), 100);
    setInterval(() => {}, 1000);
  } else {
    for (let i = 0; i < count; i++) emit(i);
  }
}
`,
    { mode: 0o755 },
  );
  fakeToolState.rgPath = rgPath;
  return rgPath;
}

describe("executeGrep native ripgrep path", () => {
  it.each([
    { multiline: false, pattern: "a.c", content: "abc\n" },
    { multiline: true, pattern: "alpha\\nbeta", content: "alpha\nbeta\n" },
  ])("ignores ambient ripgrep configuration (multiline=$multiline)", async ({ multiline, pattern, content }) => {
    // Intent: RIPGREP_CONFIG_PATH must not silently turn regex searches into literal searches,
    // in either native execution path. Use real rg so the assertion checks actual config handling.
    const root = await createTempWorkspace();
    fakeToolState.rgPath = "rg";
    const configPath = join(root, "rg.conf");
    await writeFile(configPath, "--fixed-strings\n");
    await writeFile(join(root, "example.txt"), content);
    vi.stubEnv("RIPGREP_CONFIG_PATH", configPath);

    const result = await executeGrep("grep-no-config", {
      path: "example.txt", pattern, multiline,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain(`example.txt:1: ${content.split("\n")[0]}`);
  });

  it("searches declared legacy files on their decoded text in standard and multiline mode", async () => {
    // Intent: a declared GBK file is decoded before searching, so decoded Chinese
    // text is found and the printed line is the same text read shows.
    const root = await createTempWorkspace();
    fakeToolState.rgPath = "rg";
    const sourceLine = "这是一个中文文件，用于测试旧编码识别，确保搜索输出正确。 alpha";
    await writeFile(join(root, "legacy.py"), iconv.encode(`# coding: gbk\n${sourceLine}\n`, "gbk"));

    for (const multiline of [false, true]) {
      const result = await executeGrep(`grep-gbk-${multiline}`, {
        workdir: ".",
        path: ".",
        pattern: "alpha",
        multiline,
      }, undefined, undefined, { cwd: root });

      expect(result.isError).not.toBe(true);
      expect(getText(result)).toContain(`legacy.py:2: ${sourceLine}`);
    }
  });

  it("searches replacement-decoded invalid UTF-8 in single-file and directory paths", async () => {
    // Intent: grep must search the same U+FFFD text read shows, including ASCII
    // keys, instead of taking the raw-byte path because the chosen name is UTF-8.
    const root = await createTempWorkspace();
    fakeToolState.rgPath = "rg";
    await writeFile(
      join(root, "invalid.txt"),
      Buffer.concat([Buffer.from("abc"), Buffer.from([0xff]), Buffer.from("，e\nstate=old\n")]),
    );

    for (const path of [".", "invalid.txt"]) {
      const replacement = await executeGrep("grep-replacement", {
        workdir: ".", path, pattern: "\uFFFD",
      }, undefined, undefined, { cwd: root });
      expect(replacement.isError).not.toBe(true);
      expect(getText(replacement)).toContain("invalid.txt:1: abc\uFFFD，e");

      const ascii = await executeGrep("grep-invalid-ascii", {
        workdir: ".", path, pattern: "state=old",
      }, undefined, undefined, { cwd: root });
      expect(ascii.isError).not.toBe(true);
      expect(getText(ascii)).toContain("invalid.txt:2: state=old");
    }
  });

  it("re-searches undeclared invalid UTF-8 candidates in one batched process", async () => {
    // Intent: a directory of undeclared invalid UTF-8 files must not spawn one
    // decoded process per file; one `--encoding utf-8` batch supplies read's text.
    const root = await createTempWorkspace();
    const logPath = join(root, "rg.log");
    const rgPath = join(root, "bin", "rg");
    const files = ["bad-0.txt", "bad-1.txt", "bad-2.txt"];
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(rgPath, `#!/usr/bin/env node
const fs = require("fs");
const log = (entry) => fs.appendFileSync(${JSON.stringify(logPath)}, entry + "\\n");
const args = process.argv.slice(2);
const emit = (path, text) => console.log(JSON.stringify({ type: "match", data: { path: { text: path }, lines: { text }, line_number: 1 } }));
if (args.includes("--files-with-matches")) {
  log("prepass");
  for (const file of ${JSON.stringify(files)}) process.stdout.write("./" + file + String.fromCharCode(0));
  process.exit(0);
}
if (args.includes("--json")) {
  if (args.includes("--encoding")) {
    log("batch");
    for (const file of ${JSON.stringify(files)}) emit(${JSON.stringify(root)} + "/" + file, "abc\\uFFFD");
    process.exit(0);
  }
  if (args[args.length - 1] === ".") {
    log("main");
    for (const file of ${JSON.stringify(files)}) emit(${JSON.stringify(root)} + "/" + file, "raw-only");
    process.exit(0);
  }
  log("decoded");
  process.exit(1);
}
log("other");
process.exit(2);
`, { mode: 0o755 });
    fakeToolState.rgPath = rgPath;
    for (const file of files) {
      await writeFile(join(root, file), Buffer.concat([Buffer.from("abc"), Buffer.from([0xff]), Buffer.from("\n")]));
    }

    const result = await executeGrep("grep-invalid-batch", {
      workdir: ".",
      path: ".",
      pattern: "\uFFFD",
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const text = getText(result);
    for (const file of files) expect(text).toContain(`${file}:1: abc\uFFFD`);
    expect(text).not.toContain("raw-only");
    const events = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(events.filter((event) => event === "prepass")).toHaveLength(1);
    expect(events.filter((event) => event === "main")).toHaveLength(1);
    expect(events.filter((event) => event === "batch")).toHaveLength(1);
    expect(events).not.toContain("decoded");
  });

  it("keeps the other files' matches when a batch exits 2", async () => {
    // Intent: ripgrep exits 2 when one listed file disappeared, but it still prints
    // the rest; the batch must fall back per file instead of failing the search.
    const root = await createTempWorkspace();
    const logPath = join(root, "rg.log");
    const rgPath = join(root, "bin", "rg");
    const files = ["gone.txt", "kept.txt"];
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(rgPath, `#!/usr/bin/env node
const fs = require("fs");
const log = (entry) => fs.appendFileSync(${JSON.stringify(logPath)}, entry + "\\n");
const args = process.argv.slice(2);
if (args.includes("--files-with-matches")) {
  log("prepass");
  for (const file of ${JSON.stringify(files)}) process.stdout.write("./" + file + String.fromCharCode(0));
  process.exit(0);
}
if (args.includes("--json")) {
  if (args.includes("--encoding")) {
    log("batch");
    console.error("rg: gone.txt: No such file or directory (os error 2)");
    process.exit(2);
  }
  if (args[args.length - 1] === ".") {
    log("main");
    process.exit(1);
  }
  log("decoded");
  const text = fs.readFileSync(0, "utf8");
  if (text.includes("kept")) {
    console.log(JSON.stringify({ type: "match", data: { lines: { text: "kept\\uFFFD\\n" }, line_number: 1 } }));
    process.exit(0);
  }
  console.error("unreadable");
  process.exit(2);
}
log("other");
process.exit(2);
`, { mode: 0o755 });
    fakeToolState.rgPath = rgPath;
    // The pre-scan sees both files; only one survives until the batch runs.
    await writeFile(join(root, "gone.txt"), Buffer.concat([Buffer.from("gone"), Buffer.from([0xff]), Buffer.from("\n")]));
    await writeFile(join(root, "kept.txt"), Buffer.concat([Buffer.from("kept"), Buffer.from([0xff]), Buffer.from("\n")]));

    const result = await executeGrep("grep-batch-exit-2", {
      workdir: ".",
      path: ".",
      pattern: "\uFFFD",
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const text = getText(result);
    expect(text).toContain("kept.txt:1: kept\uFFFD");
    expect(text).toContain("Search incomplete; Not searched:");
    expect(text).toContain(join(root, "gone.txt"));
    const events = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(events.filter((event) => event === "batch")).toHaveLength(1);
    expect(events.filter((event) => event === "decoded")).toHaveLength(2);
  });

  it("starts no batch when the signal is already aborted", async () => {
    // Intent: an aborted search must not spawn a batch that nothing will terminate,
    // because an already-aborted signal never fires its abort listener.
    const root = await createTempWorkspace();
    const logPath = join(root, "rg.log");
    const rgPath = join(root, "bin", "rg");
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(rgPath, `#!/usr/bin/env node
const fs = require("fs");
const log = (entry) => fs.appendFileSync(${JSON.stringify(logPath)}, entry + "\\n");
const args = process.argv.slice(2);
if (args.includes("--files-with-matches")) {
  log("prepass");
  process.stdout.write("./bad.txt" + String.fromCharCode(0));
  process.exit(0);
}
if (args.includes("--json") && args[args.length - 1] === ".") {
  log("main");
  process.exit(1);
}
log("batch-or-decoded");
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    fakeToolState.rgPath = rgPath;
    await writeFile(join(root, "bad.txt"), Buffer.concat([Buffer.from("abc"), Buffer.from([0xff]), Buffer.from("\n")]));
    const signal = AbortSignal.abort();

    const result = await executeGrep("grep-batch-already-aborted", {
      workdir: ".",
      path: ".",
      pattern: "abc",
    }, signal, undefined, { cwd: root });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Operation aborted");
    const events = await readFile(logPath, "utf8").then((text) => text.trim().split("\n").filter(Boolean)).catch(() => [] as string[]);
    expect(events).not.toContain("batch-or-decoded");
  });

  it("agrees between single-file and directory mode for CRLF invalid UTF-8", async () => {
    // Intent: a directory batch searches the raw CRLF bytes, so the single-file path
    // must use the same file search; both modes then answer multiline and `$` alike.
    const root = await createTempWorkspace();
    fakeToolState.rgPath = "rg";
    await writeFile(join(root, "bad-crlf.txt"), Buffer.concat([
      Buffer.from("alpha\r\n"),
      Buffer.from([0xff]),
      Buffer.from("beta\r\n"),
    ]));

    for (const params of [
      { pattern: "alpha\\n", multiline: true },
      { pattern: "alpha$", multiline: false },
    ]) {
      const directory = await executeGrep("grep-crlf-directory", {
        workdir: ".", path: ".", ...params,
      }, undefined, undefined, { cwd: root });
      const single = await executeGrep("grep-crlf-single", {
        workdir: ".", path: "bad-crlf.txt", ...params,
      }, undefined, undefined, { cwd: root });

      expect(directory.isError).not.toBe(true);
      expect(getText(single)).toBe(getText(directory));
    }
  });

  it("keeps a fractional limit as an integer per-file bound", async () => {
    // Intent: ripgrep rejects a fractional --max-count, so 1.5 must still search
    // instead of failing the whole call.
    const root = await createTempWorkspace();
    fakeToolState.rgPath = "rg";
    await writeFile(join(root, "bad.txt"), Buffer.concat([Buffer.from("alpha\nalpha\n"), Buffer.from([0xff]), Buffer.from("\n")]));

    const result = await executeGrep("grep-fractional-limit", {
      workdir: ".",
      path: ".",
      pattern: "alpha",
      limit: 1.5,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const lines = getText(result).split("\n").filter((line) => line.includes("alpha"));
    expect(lines).toHaveLength(1);
    expect(getText(result)).toContain("matches limit reached");
  });

  it("renders read's replacement decoding for every invalid UTF-8 edge case", async () => {
    // Intent: ripgrep's raw search can split invalid sequences differently from
    // Node's decoder; the batched --encoding utf-8 search must agree with read.
    const root = await createTempWorkspace();
    fakeToolState.rgPath = "rg";
    const cases = ["e4b841", "f09f9841", "eda08041", "c0af41", "f580808041", "e08041", "fffe41"];
    for (const hex of cases) {
      await writeFile(join(root, `bad-${hex}.txt`), Buffer.concat([Buffer.from("A"), Buffer.from(hex, "hex"), Buffer.from("B\n")]));
    }

    const result = await executeGrep("grep-invalid-edge-cases", {
      workdir: ".",
      path: ".",
      pattern: "\uFFFD",
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const text = getText(result);
    for (const hex of cases) {
      const expected = Buffer.concat([Buffer.from("A"), Buffer.from(hex, "hex"), Buffer.from("B\n")]).toString("utf8");
      expect(text).toContain(`bad-${hex}.txt:1: ${expected.replace("\n", "")}`);
    }
    expect(text).not.toContain("Search incomplete");
  });

  it("keeps read's line numbers for invalid UTF-8 with lone carriage returns", async () => {
    // Intent: ripgrep's file search only counts LF, while read also splits on lone
    // CR; this candidate must keep the normalized stdin search so both paths agree.
    const root = await createTempWorkspace();
    fakeToolState.rgPath = "rg";
    await writeFile(join(root, "bad-cr.txt"), Buffer.concat([Buffer.from("first"), Buffer.from([0xff]), Buffer.from("\rsecond\n")]));

    const directory = await executeGrep("grep-cr-directory", {
      workdir: ".",
      path: ".",
      pattern: "second",
    }, undefined, undefined, { cwd: root });
    const single = await executeGrep("grep-cr-single", {
      workdir: ".",
      path: "bad-cr.txt",
      pattern: "second",
    }, undefined, undefined, { cwd: root });

    expect(getText(directory)).toContain("bad-cr.txt:2: second");
    expect(getText(single)).toContain("bad-cr.txt:2: second");
  });

  it("matches UTF-8 and UTF-16 byte order mark files with read's line numbers", async () => {
    // Intent: the raw main search keeps ripgrep's own BOM sniffing, so BOM-marked
    // files stay searchable even though only invalid UTF-8 is re-searched.
    const root = await createTempWorkspace();
    fakeToolState.rgPath = "rg";
    await writeFile(join(root, "bom-utf8.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("alpha\nbeta\ngamma\n")]));
    await writeFile(join(root, "bom-utf16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("alpha\nbeta\ngamma\n", "utf16le")]));

    const result = await executeGrep("grep-bom-files", {
      workdir: ".",
      path: ".",
      pattern: "beta",
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const text = getText(result);
    expect(text).toContain("bom-utf8.txt:2: beta");
    expect(text).toContain("bom-utf16.txt:2: beta");
  });

  it("keeps the UTF-8 fast path for candidates that only mention declaration-like text", async () => {
    // Intent: a valid UTF-8 source containing "charset" is a pre-pass candidate,
    // but it must not spawn a second decoded-text search after the main search.
    const root = await createTempWorkspace();
    const logPath = join(root, "rg.log");
    const rgPath = join(root, "bin", "rg");
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(rgPath, `#!/usr/bin/env node
const fs = require("fs");
const log = (entry) => fs.appendFileSync(${JSON.stringify(logPath)}, entry + "\\n");
const args = process.argv.slice(2);
if (args.includes("--files-with-matches")) {
  log("prepass");
  process.stdout.write("./mention.ts" + String.fromCharCode(0));
  process.exit(0);
}
if (args.includes("--json")) {
  if (args[args.length - 1] === ".") {
    log("main");
    console.log(JSON.stringify({ type: "match", data: { path: { text: "./mention.ts" }, lines: { text: "const charset = 'utf-8';\\n" }, line_number: 1 } }));
    process.exit(0);
  }
  log("decoded");
  process.exit(1);
}
log("other");
process.exit(2);
`, { mode: 0o755 });
    fakeToolState.rgPath = rgPath;
    await writeFile(join(root, "mention.ts"), "const charset = 'utf-8';\n", "utf8");

    const result = await executeGrep("grep-utf8-fast-path", {
      workdir: ".",
      path: ".",
      pattern: "charset",
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("mention.ts:1: const charset = 'utf-8';");
    const events = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(events.filter((event) => event === "prepass")).toHaveLength(1);
    expect(events.filter((event) => event === "main")).toHaveLength(1);
    expect(events).not.toContain("decoded");
  });

  it("lists every rejected file up to ten paths and counts the rest", async () => {
    // Intent: files with an unusable declaration must stay visible even without
    // matches, and the incomplete-search notice has to stay bounded.
    const root = await createTempWorkspace();
    fakeToolState.rgPath = "rg";
    for (let index = 0; index < 12; index++) {
      await writeFile(join(root, `legacy-${String(index).padStart(2, "0")}.py`), "# coding: x-unknown\n中文\n", "utf8");
    }

    const result = await executeGrep("grep-not-searched", {
      workdir: ".",
      path: ".",
      pattern: "中文",
    }, undefined, undefined, { cwd: root });

    const text = getText(result);
    expect(text).toContain("No matches found in searched files");
    expect(text).toContain("Search incomplete; Not searched:");
    expect(text).toContain("and 2 more");
    expect((text.match(/\/legacy-\d\d\.py/g) ?? []).length).toBe(10);
  });

  it("runs the encoding pre-pass concurrently with the main search in one extra process", async () => {
    // Intent: the candidate scan must overlap the main search instead of running before it,
    // and a directory search must spawn exactly one extra rg process for it.
    const root = await createTempWorkspace();
    const logPath = join(root, "rg.log");
    const rgPath = join(root, "bin", "rg");
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(rgPath, `#!/usr/bin/env node
const fs = require("fs");
const log = (entry) => fs.appendFileSync(${JSON.stringify(logPath)}, entry + "\\n");
if (process.argv.includes("--files-with-matches")) {
  log("prepass-start");
  setTimeout(() => { log("prepass-end"); process.exit(1); }, 150);
} else {
  log("main-start");
  console.log(JSON.stringify({ type: "match", data: { path: { text: ${JSON.stringify(join(root, "example.txt"))} }, lines: { text: "alpha\\n" }, line_number: 1 } }));
  log("main-end");
}
`, { mode: 0o755 });
    fakeToolState.rgPath = rgPath;
    await writeFile(join(root, "example.txt"), "alpha\n", "utf8");

    const result = await executeGrep("grep-concurrent-prepass", {
      workdir: ".",
      path: ".",
      pattern: "alpha",
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const events = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(events.filter((event) => event === "prepass-start")).toHaveLength(1);
    expect(events.filter((event) => event === "main-start")).toHaveLength(1);
    expect(events.indexOf("main-start")).toBeLessThan(events.indexOf("prepass-end"));
  });

  it("returns the required-argument error for a missing pattern", async () => {
    // Intent: direct callers must receive the same required-argument contract as schema-driven
    // tool calls instead of an unrelated path or ripgrep failure.
    const result = await executeGrep("grep-missing-pattern", {
      path: "does-not-exist",
    }, undefined, undefined, { cwd: "/does-not-exist" });

    expect(result.isError).toBe(true);
    expect(getText(result)).toBe("Error: pattern is required.");
  });

  it("passes ignore_case through to native ripgrep", async () => {
    // Intent: display-only coverage is insufficient; the native process must receive
    // `--ignore-case` or mixed-case searches silently return incomplete results.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "example.txt");
    await writeFile(filePath, "Alpha\n", "utf8");
    process.env.PI_BASE_FAKE_RG_FILE = filePath;
    process.env.PI_BASE_FAKE_RG_TEXT = "Alpha\n";
    process.env.PI_BASE_FAKE_RG_REQUIRE_IGNORE_CASE = "1";

    const result = await executeGrep("grep-ignore-case", {
      workdir: ".",
      path: "example.txt",
      pattern: "alpha",
      ignore_case: true,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("example.txt:2: Alpha");
  });

  it("skips unparseable ripgrep output lines and formats matches as relative locations", async () => {
    // Intent: pi-base owns rg JSON parsing; a stray non-JSON line must be ignored while
    // valid match records still render as `path:line: text` candidate locations only
    // (grep no longer emits surrounding context lines).
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "src", "example.ts");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
    process.env.PI_BASE_FAKE_RG_MODE = "invalid-json";
    process.env.PI_BASE_FAKE_RG_FILE = filePath;

    const result = await executeGrep("grep-1", {
      workdir: ".",
      path: "src",
      pattern: "beta",
    }, undefined, undefined, { cwd: root });

    const text = getText(result);
    expect(text).toContain("example.ts:2: beta");
    expect(text).not.toContain("example.ts-1- alpha");
    expect(text).not.toContain("example.ts-3- gamma");
    expect(result.isError).not.toBe(true);
  });

  it("reads the matched line from disk when ripgrep omits line text", async () => {
    // Intent: some rg outputs omit matched line text; grep must fall back to reading the
    // single matched line from disk so the location still renders as path:line: text.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "src", "example.ts");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
    process.env.PI_BASE_FAKE_RG_MODE = "match";
    process.env.PI_BASE_FAKE_RG_FILE = filePath;
    process.env.PI_BASE_FAKE_RG_NO_LINES = "1";

    const result = await executeGrep("grep-nolines", {
      workdir: ".",
      path: "src",
      pattern: "beta",
    }, undefined, undefined, { cwd: root });

    const text = getText(result);
    expect(text).toContain("example.ts:2: beta");
    expect(text).not.toContain("example.ts-3- gamma");
    expect(result.isError).not.toBe(true);
  });

  it("reports match limits and long-line truncation from ripgrep output", async () => {
    // Intent: grep results are often large; the limit/truncation metadata is
    // what prevents the model from assuming the result set is complete.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "example.txt");
    await writeFile(filePath, `${"x".repeat(800)}\n`, "utf8");
    process.env.PI_BASE_FAKE_RG_MODE = "match";
    process.env.PI_BASE_FAKE_RG_FILE = filePath;
    process.env.PI_BASE_FAKE_RG_TEXT = `${"x".repeat(800)}\n`;
    process.env.PI_BASE_FAKE_RG_COUNT = "3";

    const result = await executeGrep("grep-2", {
      workdir: ".",
      path: "example.txt",
      pattern: "x",
      limit: 1,
    }, undefined, undefined, { cwd: root });

    expect(getText(result)).toContain("1 matches limit reached");
    expect(getText(result)).toContain("Some lines truncated to 500 chars");
    expect((result as any).details.matchLimitReached).toBe(1);
    expect((result as any).details.linesTruncated).toBe(true);
  });

  it("leaves byte truncation to the shared tool-output layer", async () => {
    // Intent: native grep must return its complete match-limited payload so the shared output
    // policy can persist the full text before presenting a truncated preview.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "large.txt");
    await writeFile(filePath, "match\n", "utf8");
    process.env.PI_BASE_FAKE_RG_FILE = filePath;
    process.env.PI_BASE_FAKE_RG_TEXT = `${"x".repeat(490)}\n`;
    process.env.PI_BASE_FAKE_RG_COUNT = "120";

    const result = await executeGrep("grep-large", {
      workdir: ".",
      path: "large.txt",
      pattern: "x",
      limit: 120,
    }, undefined, undefined, { cwd: root });

    expect(getText(result).length).toBeGreaterThan(50 * 1024);
    // Exactly-limit searches may omit details entirely; what matters is that no
    // byte-truncation metadata was applied by the native layer itself.
    expect((result as any).details?.truncation).toBeUndefined();
  });

  it("persists complete native grep output before returning the shared truncated preview", async () => {
    // Intent: the registered tool must connect native grep's complete payload to the shared output
    // policy, preserving a recoverable full-output file for results above the byte budget.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "large.txt");
    await writeFile(filePath, "match\n", "utf8");
    process.env.PI_BASE_FAKE_RG_FILE = filePath;
    process.env.PI_BASE_FAKE_RG_TEXT = `${"x".repeat(490)}\n`;
    process.env.PI_BASE_FAKE_RG_COUNT = "120";
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const result = await registry.getTool("grep").execute(
      "grep-shared-output",
      { workdir: ".", path: "large.txt", pattern: "x", limit: 120 },
      undefined,
      undefined,
      { cwd: root },
    );

    const outputPath = (result as any).details?.truncation?.outputPath;
    const preview = getText(result);
    expect(outputPath).toBeTruthy();
    const saved = await readFile(outputPath, "utf8");
    expect(preview).toContain("Full output (");
    expect(preview.length).toBeLessThan(saved.length);
    expect(saved.length).toBeGreaterThan(50 * 1024);
  });

  it("returns no-match and ripgrep failure results distinctly", async () => {
    // Intent: rg exit code 1 means no matches, while other non-zero exits must
    // remain actionable errors for the agent.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "example.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    process.env.PI_BASE_FAKE_RG_FILE = filePath;

    process.env.PI_BASE_FAKE_RG_MODE = "no-match";
    const noMatch = await executeGrep("grep-3", { workdir: ".", path: "example.txt", pattern: "missing" }, undefined, undefined, { cwd: root });
    expect(getText(noMatch)).toBe("No matches found");
    expect(noMatch.isError).not.toBe(true);

    process.env.PI_BASE_FAKE_RG_MODE = "error";
    const failed = await executeGrep("grep-4", { workdir: ".", path: "example.txt", pattern: "alpha" }, undefined, undefined, { cwd: root });
    expect(failed.isError).toBe(true);
    expect(getText(failed)).toContain("synthetic rg failure");
    expect(getText(failed)).not.toContain("literal=true");
  });

  it("reports a timeout when ripgrep does not finish before timeout_seconds", async () => {
    // Intent: timeout handling is part of the contract for broad searches and
    // must convert a cancelled child process into a clear tool error.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "example.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    process.env.PI_BASE_FAKE_RG_MODE = "wait";
    process.env.PI_BASE_FAKE_RG_FILE = filePath;

    const result = await executeGrep("grep-5", {
      workdir: ".",
      path: "example.txt",
      pattern: "alpha",
      timeout_seconds: 0.05,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).toBe(true);
    expect(getText(result)).toBe("Error: Search timed out after 0.05s.");
  });

  it("applies grep timeout while waiting for ripgrep acquisition", async () => {
    // Intent: a 20ms search timeout must cancel only this caller's wait for a
    // mocked 250ms acquisition instead of blocking until acquisition completes.
    vi.useFakeTimers();
    try {
      const root = await createTempWorkspace();
      await writeFile(join(root, "example.txt"), "alpha\n", "utf8");
      fakeToolState.rgPath = "rg";
      fakeToolState.acquisitionDelayMs = 250;

      const pending = executeGrep("grep-acquisition-timeout", {
        workdir: ".",
        path: "example.txt",
        pattern: "alpha",
        timeout_seconds: 0.02,
      }, undefined, undefined, { cwd: root });
      await vi.advanceTimersByTimeAsync(20);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("Error: Search timed out after 0.02s.");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { multiline: false, label: "standard" },
    { multiline: true, label: "multiline" },
  ])("roots include globs at the directory search root instead of process cwd ($label)", async ({ multiline, label }) => {
    // Intent: ripgrep roots --glob at its own process cwd, so an absolute search
    // path plus a relative glob like `src/*.ts` finds nothing (verified with real
    // rg 14). The directory path must spawn rg with cwd=searchPath searching ".",
    // in both native execution paths, so glob semantics follow the caller's path.
    const root = await createTempWorkspace();
    fakeToolState.rgPath = "rg";
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "example.ts"), "alpha\n", "utf8");
    await writeFile(join(root, "other.txt"), "alpha\n", "utf8");

    // Globs are relative to the search path: searching the workspace root with
    // `src/*.ts` must reach the nested file, which the old process-cwd glob
    // rooting could not express at all.
    const result = await executeGrep(`grep-glob-root-${label}`, {
      workdir: ".",
      path: ".",
      pattern: "alpha",
      include: "src/*.ts",
      multiline,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("example.ts:1: alpha");
  });

  it.each([
    { multiline: false, label: "standard" },
    { multiline: true, label: "multiline" },
  ])("strips leading ./ from include globs and keeps ! negation ($label)", async ({ multiline, label }) => {
    // Intent: ripgrep never matches a leading "./" glob (verified with real rg 14),
    // silently returning nothing; negated globs must survive the strip.
    const root = await createTempWorkspace();
    fakeToolState.rgPath = "rg";
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "example.ts"), "alpha\n", "utf8");
    await writeFile(join(root, "other.txt"), "alpha\n", "utf8");

    const result = await executeGrep(`grep-glob-dot-slash-${label}`, {
      workdir: ".",
      path: ".",
      pattern: "alpha",
      include: "./src/*.ts",
      multiline,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const text = getText(result);
    expect(text).toContain("src/example.ts:1: alpha");
    expect(text).not.toContain("other.txt");

    const excluded = await executeGrep(`grep-glob-negated-${label}`, {
      path: ".",
      pattern: "alpha",
      include: "!./src/*.ts",
      multiline,
    }, undefined, undefined, { cwd: root });

    expect(excluded.isError).not.toBe(true);
    expect(getText(excluded)).toContain("other.txt:1: alpha");
    expect(getText(excluded)).not.toContain("src/example.ts");
  });

  it.each([
    { multiline: false, label: "standard" },
    { multiline: true, label: "multiline" },
  ])("searches symlinked directories through the link with the glob rooted at the link ($label)", async ({ multiline, label }) => {
    // Intent: rg canonicalizes its cwd; searching a symlinked directory by absolute
    // path (common on macOS /tmp) puts the real path outside the glob root, so the
    // directory search must run inside the symlinked searchPath itself.
    const root = await createTempWorkspace();
    fakeToolState.rgPath = "rg";
    const realDir = join(root, "real");
    await mkdir(join(realDir, "src"), { recursive: true });
    await writeFile(join(realDir, "src", "example.ts"), "alpha\n", "utf8");
    await symlink(realDir, join(root, "linked"));

    const result = await executeGrep(`grep-glob-symlink-${label}`, {
      workdir: ".",
      path: "linked",
      pattern: "alpha",
      include: "src/*.ts",
      multiline,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("src/example.ts:1: alpha");
  });

  it.each([
    { multiline: false, label: "standard" },
    { multiline: true, label: "multiline" },
  ])("resolves rg relative paths against the search root when formatting and re-reading ($label)", async ({ multiline, label }) => {
    // Intent: once directory searches spawn rg with cwd=searchPath, match paths come
    // back relative to that root (real rg emits "./example.ts" for a match in the
    // root itself); both formatting and the missing-line-text fallback must resolve
    // them against the search root, not the process cwd.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "example.ts");
    await writeFile(filePath, "alpha\nbeta\n", "utf8");
    process.env.PI_BASE_FAKE_RG_MODE = "match";
    process.env.PI_BASE_FAKE_RG_FILE = "./example.ts";
    if (multiline) {
      // Multiline formatting renders event line text; there is no disk fallback there.
      process.env.PI_BASE_FAKE_RG_TEXT = "beta\n";
    } else {
      process.env.PI_BASE_FAKE_RG_NO_LINES = "1";
    }

    const result = await executeGrep(`grep-relative-fallback-${label}`, {
      workdir: ".",
      path: ".",
      pattern: "beta",
      multiline,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("example.ts:2: beta");
  });

  it.each([
    { multiline: false, label: "standard" },
    { multiline: true, label: "multiline" },
  ])("supports absolute-path fake output on directory searches ($label)", async ({ multiline, label }) => {
    // Intent: extension hosts still hand grep absolute fake rg paths; both native
    // paths must keep formatting them relative to the search root.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "example.ts");
    await writeFile(filePath, "alpha\n", "utf8");
    process.env.PI_BASE_FAKE_RG_MODE = "match";
    process.env.PI_BASE_FAKE_RG_FILE = filePath;
    process.env.PI_BASE_FAKE_RG_TEXT = "alpha\n";

    const result = await executeGrep(`grep-absolute-fake-${label}`, {
      workdir: ".",
      path: ".",
      pattern: "alpha",
      multiline,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    // The fake rg emits line numbers i+2; only the path formatting is under test here.
    expect(getText(result)).toContain("example.ts:2: alpha");
  });

  it.each([
    { multiline: false, label: "standard" },
    { multiline: true, label: "multiline" },
  ])("does not warn when the number of matches exactly equals limit ($label)", async ({ multiline, label }) => {
    // Intent: reaching the limit only proves truncation when at least one further
    // match event arrives; exactly N matches must return silently without the
    // limit notice or details.matchLimitReached.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "example.txt");
    await writeFile(filePath, "alpha\nalpha\nalpha\n", "utf8");
    process.env.PI_BASE_FAKE_RG_MODE = "match";
    process.env.PI_BASE_FAKE_RG_FILE = filePath;
    process.env.PI_BASE_FAKE_RG_TEXT = "alpha\n";
    process.env.PI_BASE_FAKE_RG_COUNT = "3";

    const result = await executeGrep(`grep-exact-limit-${label}`, {
      workdir: ".",
      path: "example.txt",
      pattern: "alpha",
      limit: 3,
      multiline,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const text = getText(result);
    expect(text).toContain("alpha");
    expect(text).not.toContain("limit reached");
    expect((result as any).details?.matchLimitReached).toBeUndefined();
  });

  it("keeps the real-overflow limit notice and never leaks the lookahead match", async () => {
    // Intent: one more match event beyond the limit must still trigger the truncation
    // notice, and the terminating lookahead match must not appear in the output.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "example.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    process.env.PI_BASE_FAKE_RG_MODE = "match";
    process.env.PI_BASE_FAKE_RG_FILE = filePath;
    process.env.PI_BASE_FAKE_RG_TEXT = "alpha\n";
    process.env.PI_BASE_FAKE_RG_COUNT = "3";

    const result = await executeGrep("grep-real-overflow", {
      workdir: ".",
      path: "example.txt",
      pattern: "alpha",
      limit: 2,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    const text = getText(result);
    expect((result as any).details?.matchLimitReached).toBe(2);
    expect(text).toContain("2 matches limit reached");
    const matchLines = text.split("\n").filter((line) => line.includes("alpha"));
    expect(matchLines).toHaveLength(2);
  });

  it.each([false, true])("waits for a delayed lookahead match, then stops rg (multiline=%s)", async (multiline) => {
    // Intent: matches may arrive in different stdout chunks. Killing rg at N
    // loses the delayed (N+1)th match and hides truncation; after that match arrives
    // grep must stop the process, which otherwise stays alive until the timeout.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "example.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    process.env.PI_BASE_FAKE_RG_MODE = "paced-overflow";
    process.env.PI_BASE_FAKE_RG_FILE = filePath;
    process.env.PI_BASE_FAKE_RG_TEXT = "alpha\n";
    process.env.PI_BASE_FAKE_RG_COUNT = "3";

    const result = await executeGrep("grep-overflow-cancel", {
      path: "example.txt",
      pattern: "alpha",
      limit: 2,
      timeout_seconds: 2,
      multiline,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).not.toBe(true);
    expect((result as any).details?.matchLimitReached).toBe(2);
    const matchLines = getText(result).split("\n").filter((line) => line.includes("alpha"));
    expect(matchLines).toHaveLength(2);
  });
});
