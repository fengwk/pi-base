import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import iconv from "iconv-lite";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApplyPatchCommitError,
  executeApplyPatch,
  getApplyPatchIntents,
  parseApplyPatch,
} from "../src/apply-patch-core.js";

const tempRoots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-base-apply-patch-"));
  tempRoots.push(root);
  return root;
}

async function put(root: string, path: string, content: string | Buffer): Promise<string> {
  const absolutePath = join(root, path);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content);
  return absolutePath;
}

function patch(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function createQueueBlocker(path: string): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const releasedPromise = new Promise<void>((resolve) => { release = resolve; });
  const done = withFileMutationQueue(path, async () => {
    started();
    await releasedPromise;
  });
  await startedPromise;
  return { release, done };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("apply_patch parser", () => {
  it("parses all operations, change context, EOF, move metadata, and exposes intents", () => {
    // Intent: the later wrapper needs a stable pure representation before it asks
    // for permissions or constructs context-compression metadata.
    const parsed = parseApplyPatch(patch(
      "*** Add File: add.txt",
      "+hello",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "@@ function demo()",
      "-old",
      "+new",
      "*** End of File",
      "*** Delete File: gone.txt",
    ));

    expect(parsed.files).toEqual([
      { operation: "add", path: "add.txt", lines: ["hello"] },
      {
        operation: "update",
        path: "old.txt",
        moveTo: "new.txt",
        chunks: [{
          changeContext: "function demo()",
          lines: [
            { kind: "delete", text: "old" },
            { kind: "add", text: "new" },
          ],
          endOfFile: true,
        }],
      },
      { operation: "delete", path: "gone.txt" },
    ]);
    expect(getApplyPatchIntents(parsed)).toEqual([
      { operation: "add", path: "add.txt" },
      { operation: "update", path: "old.txt", moveTo: "new.txt" },
      { operation: "delete", path: "gone.txt" },
    ]);
  });

  it("accepts a leading UTF BOM", () => {
    // Intent: JavaScript trim/OpenCode treat the BOM as leading whitespace, so
    // transport-encoded patch text must parse like the same text without a BOM.
    expect(parseApplyPatch(`\uFEFF${patch("*** Add File: bom.txt", "+ok")}`).files).toEqual([
      { operation: "add", path: "bom.txt", lines: ["ok"] },
    ]);
  });

  it("accepts horizontal whitespace around envelope markers and heredoc closing delimiters", () => {
    // Intent: OpenCode tolerates cosmetic spaces/tabs at the protocol boundary,
    // but that tolerance must not turn surrounding Markdown/prose into a patch.
    const whitespaceEnvelope = [
      " \t*** Begin Patch\t ",
      "*** Add File: spaced.txt",
      "+ok",
      "\t*** End Patch  ",
    ].join("\n");
    expect(parseApplyPatch(whitespaceEnvelope).files).toEqual([
      { operation: "add", path: "spaced.txt", lines: ["ok"] },
    ]);
    expect(parseApplyPatch(`<<EOF\n${whitespaceEnvelope}\nEOF \t`).files).toHaveLength(1);
    expect(() => parseApplyPatch(`\`\`\`\n${patch("*** Add File: fenced.txt", "+no")}\n\`\`\``))
      .toThrow(/start with/);
  });

  it("accepts CRLF/CR patches and quoted or unquoted heredoc wrappers", () => {
    // Intent: shell-shaped model output and Windows transports should reach the
    // same parser without leaking carriage returns into patch content.
    const body = patch("*** Add File: a.txt", "+one", "+two");
    expect(parseApplyPatch(`cat <<'EOF'\r\n${body.replace(/\n/g, "\r\n")}\r\nEOF\r\n`).files[0]).toMatchObject({
      operation: "add",
      lines: ["one", "two"],
    });
    expect(parseApplyPatch(`<<EOF\r${body.replace(/\n/g, "\r")}\rEOF`).files).toHaveLength(1);
    expect(parseApplyPatch(`<<"EOF"\n${body}\nEOF`).files).toHaveLength(1);
    expect(parseApplyPatch(`cat <<"EOF"\n${body}\nEOF`).files).toHaveLength(1);
    expect(parseApplyPatch(`<<123\n${body}\n123`).files).toHaveLength(1);
  });

  it("accepts surrounding blank whitespace and every supported @@ context form", () => {
    const input = ` \n\t\n${patch(
      "*** Update File: file.txt",
      "@@first context",
      "+one",
      "@@ second context",
      "+two",
      "@@",
      "+three",
    )}\n \t\n`;
    const parsed = parseApplyPatch(input);
    expect(parsed.files[0]).toMatchObject({
      operation: "update",
      chunks: [
        { changeContext: "first context" },
        { changeContext: "second context" },
        { changeContext: undefined },
      ],
    });
  });

  it.each([
    ["missing begin", "*** Add File: a\n+x\n*** End Patch", /start with/],
    ["missing end", "*** Begin Patch\n*** Add File: a\n+x", /end with/],
    ["empty patch", patch(), /at least one file operation/],
    ["unknown directive", patch("*** Frobnicate File: a"), /Unknown patch line/],
    ["empty add path", patch("*** Add File:   ", "+x"), /path must not be empty/],
    ["empty update path", patch("*** Update File:", "@@", "-x", "+y"), /path must not be empty/],
    ["empty delete path", patch("*** Delete File:"), /path must not be empty/],
    ["add line without plus", patch("*** Add File: a", "plain"), /must start with \+/],
    ["delete body", patch("*** Delete File: a", "+not allowed"), /must not have a body/],
    ["update without chunk", patch("*** Update File: a"), /at least one @@ chunk/],
    ["malformed chunk header", patch("*** Update File: a", "not @@"), /expected an @@ chunk/],
    ["unknown chunk line", patch("*** Update File: a", "@@", "?bad"), /space, -, or \+/],
    ["empty chunk", patch("*** Update File: a", "@@"), /at least one line/],
    ["misplaced eof", patch("*** Update File: a", "@@", "-x", "+y", "*** End of File", "+z"), /must end the update/],
    ["duplicate source", patch("*** Add File: a", "+x", "*** Delete File: a"), /Duplicate patch path/],
    ["duplicate move target", patch("*** Update File: a", "*** Move to: b", "@@", "-x", "+y", "*** Add File: b", "+z"), /Duplicate patch path/],
    ["trailing garbage", `${patch("*** Add File: a", "+x")}\ngarbage`, /after \*\*\* End Patch/],
    ["unclosed heredoc", `<<EOF\n${patch("*** Add File: a", "+x")}`, /missing closing EOF/],
  ])("rejects %s", (_name, input, expected) => {
    expect(() => parseApplyPatch(input)).toThrow(expected);
  });

  it("parses Move for compatibility but rejects it before filesystem work", async () => {
    const root = await createRoot();
    await put(root, "old.txt", "old\n");
    const input = patch("*** Update File: old.txt", "*** Move to: new.txt", "@@", "-old", "+new");
    await expect(executeApplyPatch(input, { cwd: root })).rejects.toThrow(/Move operations are not supported/);
    expect(await readFile(join(root, "old.txt"), "utf8")).toBe("old\n");
  });
});

describe("apply_patch matching and planning", () => {
  it.each([
    ["exact", "alpha\n", "alpha", "beta", "beta\n"],
    ["trimEnd", "alpha   \n", "alpha", "beta", "beta\n"],
    ["trim", "  alpha   \n", "alpha", "beta", "beta\n"],
    ["normalized Unicode punctuation", "say “hello”—now\n", "say \"hello\"-now", "done", "done\n"],
  ])("applies a unique %s match", async (_level, source, oldLine, newLine, expected) => {
    const root = await createRoot();
    await put(root, "file.txt", source);
    const result = await executeApplyPatch(patch("*** Update File: file.txt", "@@", `-${oldLine}`, `+${newLine}`), { cwd: root });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe(expected);
    expect(result.files[0]).toMatchObject({ operation: "update", path: "file.txt", before: source, after: expected });
  });

  it.each([
    ["exact", "x\nx\n", "x", /exact matching/],
    ["trimEnd", "x \nx  \n", "x", /trimEnd matching/],
    ["trim", " x \n  x  \n", "x", /trim matching/],
    ["unicode", "“x”\n“x”\n", "\"x\"", /unicode matching/],
  ])("rejects ambiguity at the first matching level: %s", async (_level, source, oldLine, expected) => {
    const root = await createRoot();
    await put(root, "file.txt", source);
    await expect(executeApplyPatch(patch("*** Update File: file.txt", "@@", `-${oldLine}`, "+y"), { cwd: root }))
      .rejects.toThrow(expected);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe(source);
  });

  it("uses change context to disambiguate a later region", async () => {
    // Intent: @@ labels narrow a repeated hunk without becoming part of the
    // replaced text, matching Codex/OpenCode's function/section context form.
    const root = await createRoot();
    await put(root, "file.txt", "section one\ntarget\nsection two\ntarget\n");
    await executeApplyPatch(patch(
      "*** Update File: file.txt",
      "@@ section two",
      "-target",
      "+changed",
    ), { cwd: root });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("section one\ntarget\nsection two\nchanged\n");
  });

  it("preserves context lines while replacing the enclosed deletion", async () => {
    const root = await createRoot();
    await put(root, "file.txt", "before\r\ntarget\nafter\r");
    await executeApplyPatch(patch(
      "*** Update File: file.txt",
      "@@",
      " before",
      "-target",
      "+changed",
      " after",
    ), { cwd: root });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("before\r\nchanged\nafter\r");
  });

  it("anchors an EOF chunk to the last matching sequence", async () => {
    const root = await createRoot();
    await put(root, "file.txt", "target\nmiddle\ntarget\n");
    await executeApplyPatch(patch(
      "*** Update File: file.txt",
      "@@",
      "-target",
      "+last",
      "*** End of File",
    ), { cwd: root });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("target\nmiddle\nlast\n");
  });

  it("enforces monotonic chunk ordering", async () => {
    const root = await createRoot();
    const source = "a\nb\nc\n";
    await put(root, "file.txt", source);
    await expect(executeApplyPatch(patch(
      "*** Update File: file.txt",
      "@@",
      "-b",
      "+B",
      "@@",
      "-a",
      "+A",
    ), { cwd: root })).rejects.toThrow(/could not match old lines for chunk 2/);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe(source);
  });

  it("validates change context before appending a pure insertion at EOF", async () => {
    // Intent: change context remains a guard for insertion-only chunks even though
    // OpenCode appends their added lines at EOF rather than beside the context.
    const root = await createRoot();
    await put(root, "file.txt", "anchor\nhead");
    await executeApplyPatch(patch("*** Update File: file.txt", "@@anchor", "+tail"), { cwd: root });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("anchor\nhead\ntail");
  });

  it("allows a source-line update after an insertion-only append", async () => {
    // Intent: appending consumes no old lines, so the source cursor must remain
    // before later original lines rather than jumping to the appended EOF text.
    const root = await createRoot();
    await put(root, "file.txt", "anchor\nlater\n");
    await executeApplyPatch(patch(
      "*** Update File: file.txt",
      "@@ anchor",
      "+tail",
      "@@",
      "-later",
      "+LATER",
    ), { cwd: root });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("anchor\nLATER\ntail\n");
  });

  it("moves the source-region boundary after an ordinary replacement", async () => {
    // Intent: normal replacements remain part of the searchable source region,
    // so later chunks can still reach original lines after a replacement grows it.
    const root = await createRoot();
    await put(root, "file.txt", "one\ntwo\nthree\n");
    await executeApplyPatch(patch(
      "*** Update File: file.txt",
      "@@",
      "-one",
      "+ONE",
      "+one-extra",
      "@@",
      "-three",
      "+THREE",
    ), { cwd: root });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("ONE\none-extra\ntwo\nTHREE\n");
  });

  it("does not match text appended by an earlier insertion-only chunk", async () => {
    // Intent: OpenCode searches later update chunks in the original/source region,
    // so a pure append cannot manufacture a match for a later replacement.
    const root = await createRoot();
    const source = "anchor\n";
    await put(root, "file.txt", source);
    await expect(executeApplyPatch(patch(
      "*** Update File: file.txt",
      "@@ anchor",
      "+appended",
      "@@",
      "-appended",
      "+replaced",
    ), { cwd: root })).rejects.toThrow(/could not match old lines for chunk 2/);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe(source);
  });

  it("uses OpenCode's trailing-empty-line fallback for final newline context", async () => {
    // Intent: line-oriented patch transport can include the synthetic empty line
    // after a normal final newline even though the source representation omits it.
    const root = await createRoot();
    await put(root, "file.txt", "before\nold\n");
    await executeApplyPatch(patch(
      "*** Update File: file.txt",
      "@@",
      " before",
      "-old",
      "+new",
      " ",
    ), { cwd: root });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("before\nnew\n");
  });

  it("drops only the synthetic old-side trailing empty line when the replacement is non-empty", async () => {
    // Intent: compatibility fallback must retain a real final replacement line
    // even when trailing additions follow the synthetic old-side empty line.
    const root = await createRoot();
    await put(root, "file.txt", "old\n");
    await executeApplyPatch(patch(
      "*** Update File: file.txt",
      "@@",
      "-old",
      "-",
      "+new",
    ), { cwd: root });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("new\n");
  });

  it("keeps trailing-empty-line fallback non-inserting and ambiguity-safe", async () => {
    // Intent: dropping a synthetic terminal empty old line may not create an
    // insertion, and fallback matching still rejects more than one source region.
    const root = await createRoot();
    const emptyOldSource = "present\n";
    const ambiguousSource = "before\nold\nbefore\nold\n";
    await put(root, "empty-old.txt", emptyOldSource);
    await put(root, "ambiguous.txt", ambiguousSource);

    await expect(executeApplyPatch(patch(
      "*** Update File: empty-old.txt",
      "@@",
      "-",
      "+inserted",
    ), { cwd: root })).rejects.toThrow(/could not match old lines/);
    await expect(executeApplyPatch(patch(
      "*** Update File: ambiguous.txt",
      "@@",
      " before",
      "-old",
      "+new",
      " ",
    ), { cwd: root })).rejects.toThrow(/old lines.*ambiguous/);
    expect(await readFile(join(root, "empty-old.txt"), "utf8")).toBe(emptyOldSource);
    expect(await readFile(join(root, "ambiguous.txt"), "utf8")).toBe(ambiguousSource);
  });

  it("rejects a pure insertion when its change context is missing or ambiguous", async () => {
    const root = await createRoot();
    await put(root, "missing.txt", "head\n");
    await put(root, "ambiguous.txt", "anchor\nanchor\n");
    await expect(executeApplyPatch(patch("*** Update File: missing.txt", "@@missing", "+tail"), { cwd: root }))
      .rejects.toThrow(/could not match change context/);
    await expect(executeApplyPatch(patch("*** Update File: ambiguous.txt", "@@anchor", "+tail"), { cwd: root }))
      .rejects.toThrow(/change context.*ambiguous/);
    expect(await readFile(join(root, "missing.txt"), "utf8")).toBe("head\n");
    expect(await readFile(join(root, "ambiguous.txt"), "utf8")).toBe("anchor\nanchor\n");
  });

  it("inserts into an empty file and supplies the default LF ending", async () => {
    const root = await createRoot();
    await put(root, "file.txt", "");
    await executeApplyPatch(patch("*** Update File: file.txt", "@@", "+first"), { cwd: root });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("first\n");
  });

  it("rejects chunks that contain context but no mutation", async () => {
    const root = await createRoot();
    await put(root, "file.txt", "same\n");
    await expect(executeApplyPatch(patch("*** Update File: file.txt", "@@", " same"), { cwd: root }))
      .rejects.toThrow(/contains no added or deleted lines/);
  });

  it("rejects semantic no-op updates", async () => {
    const root = await createRoot();
    await put(root, "file.txt", "same\n");
    await expect(executeApplyPatch(patch("*** Update File: file.txt", "@@", "-same", "+same"), { cwd: root }))
      .rejects.toThrow(/would make no changes/);
  });
});

describe("apply_patch filesystem execution", () => {
  it("adds, updates, and deletes multiple files after a complete preflight", async () => {
    // Intent: every committed operation must notify observers in commit order; an
    // observer failure cannot retroactively turn an applied filesystem change into an error.
    const root = await createRoot();
    await put(root, "update.txt", "old\n");
    await put(root, "delete.txt", "gone\n");
    const committed: string[] = [];
    const result = await executeApplyPatch(patch(
      "*** Add File: nested/add.txt",
      "+created",
      "*** Update File: update.txt",
      "@@",
      "-old",
      "+new",
      "*** Delete File: delete.txt",
    ), {
      cwd: root,
      onCommitted: (file) => {
        committed.push(`${file.operation}:${file.path}`);
        if (file.operation === "update") throw new Error("observer failed");
      },
    });

    expect(committed).toEqual(["add:nested/add.txt", "update:update.txt", "delete:delete.txt"]);
    expect(await readFile(join(root, "nested/add.txt"), "utf8")).toBe("created\n");
    expect(await readFile(join(root, "update.txt"), "utf8")).toBe("new\n");
    expect(await exists(join(root, "delete.txt"))).toBe(false);
    expect(result.files).toEqual([
      {
        operation: "add",
        path: "nested/add.txt",
        absolutePath: join(root, "nested/add.txt"),
        before: null,
        after: "created\n",
      },
      {
        operation: "update",
        path: "update.txt",
        absolutePath: join(root, "update.txt"),
        before: "old\n",
        after: "new\n",
      },
      {
        operation: "delete",
        path: "delete.txt",
        absolutePath: join(root, "delete.txt"),
        before: "gone\n",
        after: null,
      },
    ]);
  });

  it("creates an empty Add file without a newline", async () => {
    const root = await createRoot();
    await executeApplyPatch(patch("*** Add File: empty.txt"), { cwd: root });
    expect(await readFile(join(root, "empty.txt"))).toEqual(Buffer.alloc(0));
  });

  it.each([
    ["missing update", patch("*** Update File: missing.txt", "@@", "-a", "+b"), /file does not exist/],
    ["missing delete", patch("*** Delete File: missing.txt"), /file does not exist/],
  ])("rejects %s", async (_name, input, expected) => {
    const root = await createRoot();
    await expect(executeApplyPatch(input, { cwd: root })).rejects.toThrow(expected);
  });

  it("rejects existing Add paths and directory Update/Delete paths", async () => {
    const root = await createRoot();
    await put(root, "exists.txt", "x\n");
    await mkdir(join(root, "dir"));
    await expect(executeApplyPatch(patch("*** Add File: exists.txt", "+x"), { cwd: root })).rejects.toThrow(/requires a path that does not exist/);
    await expect(executeApplyPatch(patch("*** Update File: dir", "@@", "+x"), { cwd: root })).rejects.toThrow(/not a regular file/);
    await expect(executeApplyPatch(patch("*** Delete File: dir"), { cwd: root })).rejects.toThrow(/not a regular file/);
    await put(root, "parent", "not a directory\n");
    await expect(executeApplyPatch(patch("*** Add File: parent/child.txt", "+x"), { cwd: root }))
      .rejects.toThrow(/Parent path is not a directory/);
  });

  it("rejects binary files", async () => {
    const root = await createRoot();
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff]);
    await put(root, "binary.bin", bytes);
    await expect(executeApplyPatch(patch("*** Update File: binary.bin", "@@", "+text"), { cwd: root }))
      .rejects.toThrow(/appears to be binary/);
    expect(await readFile(join(root, "binary.bin"))).toEqual(bytes);
  });

  it("rejects output that cannot round-trip in a legacy encoding", async () => {
    // Intent: planning must encode every output before any write so legacy files
    // cannot be silently corrupted by iconv replacement characters.
    const root = await createRoot();
    const bytes = iconv.encode("café\n", "latin1");
    await put(root, "legacy.txt", bytes);
    await expect(executeApplyPatch(patch("*** Update File: legacy.txt", "@@", "-café", "+漢字"), { cwd: root }))
      .rejects.toThrow(/cannot be represented/);
    expect(await readFile(join(root, "legacy.txt"))).toEqual(bytes);
  });

  it("resolves paths relative to workdir and rejects duplicate resolved aliases", async () => {
    const root = await createRoot();
    await mkdir(join(root, "sub"));
    await expect(executeApplyPatch(patch(
      "*** Add File: a.txt",
      "+one",
      "*** Add File: ./a.txt",
      "+two",
    ), { cwd: root, workdir: "sub" })).rejects.toThrow(/Duplicate resolved patch path/);
    await expect(executeApplyPatch(patch(
      `*** Add File: ${root}/absolute.txt`,
      "+one",
      `*** Add File: ${root}/nested/../absolute.txt`,
      "+two",
    ), { cwd: root })).rejects.toThrow(/Duplicate resolved patch path/);
    expect(await exists(join(root, "sub/a.txt"))).toBe(false);
    expect(await exists(join(root, "absolute.txt"))).toBe(false);
  });

  it("treats Windows-resolved paths case-insensitively when checking duplicates", async () => {
    // Intent: two spellings of the same ordinary Windows path must not become
    // separate plans that can partially commit against one file.
    const root = await createRoot();
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      await expect(executeApplyPatch(patch(
        `*** Add File: ${root}/Case.txt`,
        "+one",
        `*** Add File: ${root}/case.txt`,
        "+two",
      ), { cwd: root })).rejects.toThrow(/Duplicate resolved patch path/);
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("uses process.cwd as the default base while preserving absolute targets", async () => {
    // Intent: callers may omit both cwd and workdir; absolute patch paths remain deterministic.
    const root = await createRoot();
    const absolutePath = join(root, "absolute-default.txt");
    await executeApplyPatch(patch(`*** Add File: ${absolutePath}`, "+ok"));
    expect(await readFile(absolutePath, "utf8")).toBe("ok\n");
  });

  it("accepts an already parsed patch for permission-first wrapper flows", async () => {
    const root = await createRoot();
    const parsed = parseApplyPatch(patch("*** Add File: parsed.txt", "+ok"));
    await executeApplyPatch(parsed, { cwd: root });
    expect(await readFile(join(root, "parsed.txt"), "utf8")).toBe("ok\n");
  });

  it("collects independent preflight failures before reporting", async () => {
    const root = await createRoot();
    const error = await executeApplyPatch(patch(
      "*** Update File: first.txt",
      "@@",
      "-a",
      "+b",
      "*** Delete File: second.txt",
    ), { cwd: root }).catch((caught) => caught);
    expect(error.message).toContain("first.txt: file does not exist");
    expect(error.message).toContain("second.txt: file does not exist");
  });

  it("keeps all files unchanged when any preflight step fails", async () => {
    // Intent: even an earlier valid Add must wait until every later read/match/
    // encode operation has succeeded.
    const root = await createRoot();
    await expect(executeApplyPatch(patch(
      "*** Add File: should-not-exist.txt",
      "+created",
      "*** Update File: missing.txt",
      "@@",
      "-old",
      "+new",
    ), { cwd: root })).rejects.toThrow(/Patch preflight failed/);
    expect(await exists(join(root, "should-not-exist.txt"))).toBe(false);
  });
});

describe("apply_patch encodings and line endings", () => {
  it("preserves a UTF-8 BOM", async () => {
    const root = await createRoot();
    const file = await put(root, "bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("old\n")]));
    await executeApplyPatch(patch("*** Update File: bom.txt", "@@", "-old", "+new"), { cwd: root });
    expect(await readFile(file)).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("new\n")]));
  });

  it("preserves UTF-16LE and its BOM", async () => {
    const root = await createRoot();
    const file = await put(root, "utf16.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("old\r\n", "utf16le")]));
    await executeApplyPatch(patch("*** Update File: utf16.txt", "@@", "-old", "+new"), { cwd: root });
    expect(await readFile(file)).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("new\r\n", "utf16le")]));
  });

  it.each([
    ["CRLF", "a\r\nb\r\n", "a\r\nB\r\n"],
    ["CR", "a\rb\r", "a\rB\r"],
    ["mixed without a final ending", "a\r\nb\nc\rd", "a\r\nB\nc\rd"],
    ["no final newline", "a\nb", "a\nB"],
  ])("preserves %s structure and final-termination state", async (_name, source, expected) => {
    const root = await createRoot();
    await put(root, "file.txt", source);
    await executeApplyPatch(patch("*** Update File: file.txt", "@@", "-b", "+B"), { cwd: root });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe(expected);
  });

  it("preserves a missing final ending across multiline replacement, deletion, and append", async () => {
    // Intent: Update changes content, not the file's final-termination convention.
    const root = await createRoot();
    await put(root, "replace.txt", "a\nb");
    await put(root, "delete.txt", "a\nb");
    await put(root, "append.txt", "a");
    await put(root, "mixed-append.txt", "a\r\nb\rc");
    await put(root, "delete-only.txt", "only");

    await executeApplyPatch(patch("*** Update File: replace.txt", "@@", "-b", "+B", "+C"), { cwd: root });
    await executeApplyPatch(patch("*** Update File: delete.txt", "@@", " a", "-b"), { cwd: root });
    await executeApplyPatch(patch("*** Update File: append.txt", "@@ a", "+b"), { cwd: root });
    await executeApplyPatch(patch("*** Update File: mixed-append.txt", "@@ a", "+tail"), { cwd: root });
    await executeApplyPatch(patch("*** Update File: delete-only.txt", "@@", "-only"), { cwd: root });

    expect(await readFile(join(root, "replace.txt"), "utf8")).toBe("a\nB\nC");
    expect(await readFile(join(root, "delete.txt"), "utf8")).toBe("a");
    expect(await readFile(join(root, "append.txt"), "utf8")).toBe("a\nb");
    expect(await readFile(join(root, "mixed-append.txt"), "utf8")).toBe("a\r\nb\rc\r\ntail");
    expect(await readFile(join(root, "delete-only.txt"), "utf8")).toBe("");
  });
});

describe("apply_patch commit races and aborts", () => {
  it("describes a first-file commit failure without claiming partial application", () => {
    const error = new ApplyPatchCommitError("first.txt", [], "boom");
    expect(error.message).toContain("No patch files were applied");
    expect(error.message).toContain("Cause: boom");
    expect(error.causeMessage).toBe("boom");
  });

  it("waits for cooperating mutations before an exclusive Add commit", async () => {
    const root = await createRoot();
    const file = join(root, "queued.txt");
    const blocker = await createQueueBlocker(file);
    let settled = false;
    const pending = executeApplyPatch(patch("*** Add File: queued.txt", "+created"), { cwd: root })
      .then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(await exists(file)).toBe(false);
    blocker.release();
    await blocker.done;
    await pending;
    expect(await readFile(file, "utf8")).toBe("created\n");
  });

  it.each(["update", "delete"] as const)("rejects a stale %s after an earlier commit", async (operation) => {
    // Intent: an observable first commit proves global preflight is complete; a
    // queued second path can then be changed deterministically before byte check.
    const root = await createRoot();
    const target = await put(root, "target.txt", "old\n");
    const blocker = await createQueueBlocker(target);
    const input = operation === "update"
      ? patch("*** Add File: marker.txt", "+done", "*** Update File: target.txt", "@@", "-old", "+new")
      : patch("*** Add File: marker.txt", "+done", "*** Delete File: target.txt");
    const pending = executeApplyPatch(input, { cwd: root });
    await waitFor(() => exists(join(root, "marker.txt")));
    if (operation === "update") await writeFile(target, "changed\n");
    else await rm(target);
    blocker.release();
    await blocker.done;

    const error = await pending.catch((caught) => caught);
    expect(error).toBeInstanceOf(ApplyPatchCommitError);
    expect(error.message).toContain("target.txt changed after preflight");
    expect(error.message).toContain("Already applied: marker.txt");
    if (operation === "update") expect(await readFile(target, "utf8")).toBe("changed\n");
    else expect(await exists(target)).toBe(false);
  });

  it("reports partial application when a later exclusive Add loses a race", async () => {
    // Intent: commit callbacks receive defensive data, and a failing cache observer
    // must not hide or replace the original filesystem error.
    const root = await createRoot();
    const second = join(root, "second.txt");
    const blocker = await createQueueBlocker(second);
    const committed: string[] = [];
    const failed: Array<{ operation: string; path: string; absolutePath: string; state: string }> = [];
    const pending = executeApplyPatch(patch(
      "*** Add File: first.txt",
      "+first",
      "*** Add File: second.txt",
      "+second",
    ), {
      cwd: root,
      onCommitted: (file) => {
        committed.push(file.path);
        file.path = "observer-mutated.txt";
        file.after = "observer-mutated\n";
      },
      onCommitFailed: (failure) => {
        failed.push({ ...failure });
        throw new Error("observer failure");
      },
    });
    await waitFor(() => exists(join(root, "first.txt")));
    await writeFile(second, "racer\n");
    blocker.release();
    await blocker.done;

    const error = await pending.catch((caught) => caught);
    expect(error).toBeInstanceOf(ApplyPatchCommitError);
    expect(error.failedPath).toBe("second.txt");
    expect(error.failedPathState).toBe("unknown");
    expect(error.appliedPaths).toEqual(["first.txt"]);
    expect(error.appliedFiles).toEqual([{
      operation: "add",
      path: "first.txt",
      absolutePath: join(root, "first.txt"),
      before: null,
      after: "first\n",
    }]);
    expect(committed).toEqual(["first.txt"]);
    expect(failed).toEqual([{
      operation: "add",
      path: "second.txt",
      absolutePath: second,
      state: "unknown",
    }]);
    expect(await readFile(join(root, "first.txt"), "utf8")).toBe("first\n");
    expect(await readFile(second, "utf8")).toBe("racer\n");
  });

  it("aborts before preflight without side effects", async () => {
    const root = await createRoot();
    const controller = new AbortController();
    controller.abort();
    await expect(executeApplyPatch(patch("*** Add File: file.txt", "+x"), { cwd: root, signal: controller.signal }))
      .rejects.toThrow("Operation aborted");
    expect(await exists(join(root, "file.txt"))).toBe(false);
  });

  it("makes an abort after an earlier commit explicit without undoing it", async () => {
    const root = await createRoot();
    const second = join(root, "second.txt");
    const blocker = await createQueueBlocker(second);
    const controller = new AbortController();
    const pending = executeApplyPatch(patch(
      "*** Add File: first.txt",
      "+first",
      "*** Add File: second.txt",
      "+second",
    ), { cwd: root, signal: controller.signal });
    await waitFor(() => exists(join(root, "first.txt")));
    controller.abort();
    blocker.release();
    await blocker.done;

    const error = await pending.catch((caught) => caught);
    expect(error).toBeInstanceOf(ApplyPatchCommitError);
    expect(error.message).toContain("Operation aborted");
    expect(error.message).toContain("Already applied: first.txt");
    expect(await readFile(join(root, "first.txt"), "utf8")).toBe("first\n");
    expect(await exists(second)).toBe(false);
  });
});
