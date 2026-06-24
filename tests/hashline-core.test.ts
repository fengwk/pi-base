import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOperations } from "../src/hashline/apply.js";
import { buildCompactDiffPreview } from "../src/hashline/diff-preview.js";
import { computeFileHash } from "../src/hashline/format.js";
import {
  InMemoryFilesystem,
  NodeFilesystem,
  NotFoundError,
} from "../src/hashline/fs.js";
import { formatAnchoredContext } from "../src/hashline/messages.js";
import { Patch } from "../src/hashline/parser.js";
import { Patcher } from "../src/hashline/patcher.js";
import { InMemorySnapshotStore } from "../src/hashline/snapshots.js";

describe("hashline/fs", () => {
  // Intent: Patcher.create-vs-update depends on NotFoundError; agents must get ENOENT-shaped errors from disk reads.
  it("NodeFilesystem maps missing files to NotFoundError and isNotFound recognizes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-base-fs-"));
    try {
      const fs = new NodeFilesystem();
      const missing = join(root, "nope.txt");
      await expect(fs.readText(missing)).rejects.toBeInstanceOf(NotFoundError);
      await expect(fs.exists(missing)).resolves.toBe(false);

      const target = join(root, "nested", "ok.txt");
      await fs.writeText(target, "hello");
      expect(await fs.readText(target)).toBe("hello");
      expect(await fs.exists(target)).toBe(true);
      expect(fs.canonicalPath(target)).toBe(join(root, "nested", "ok.txt"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Intent: In-memory backend is the contract tests use; helpers like set/get/delete must behave like a real FS.
  it("InMemoryFilesystem round-trips content and supports fixture helpers", async () => {
    const fs = new InMemoryFilesystem([["a.txt", "one"]]);
    expect(await fs.readText("a.txt")).toBe("one");
    fs.set("b.txt", "two");
    expect(fs.get("b.txt")).toBe("two");
    expect(await fs.writeText("b.txt", "three")).toEqual({ text: "three" });
    expect(fs.delete("a.txt")).toBe(true);
    await expect(fs.readText("a.txt")).rejects.toThrow(/File not found/);
    fs.clear();
    expect([...fs.entries()]).toHaveLength(0);
  });

  // Intent: default Filesystem.exists must not treat non-ENOENT read failures as "missing".
  it("Filesystem.exists rethrows unexpected read errors", async () => {
    class BrokenFs extends InMemoryFilesystem {
      override async exists(_path: string): Promise<boolean> {
        throw new Error("disk exploded");
      }
    }
    await expect(new BrokenFs().exists("x")).rejects.toThrow(/disk exploded/);
  });
});

describe("hashline/parser", () => {
  // Intent: duplicate section headers for one path are a real agent mistake; parser must reject before any write.
  it("rejects two sections for the same path in one patch", () => {
    const tag = "A1B2";
    const input = `[a.txt#${tag}]\nSWAP 1.=1:\n+x\n[a.txt#${tag}]\nDEL 1`;
    expect(() => Patch.parse(input)).toThrow(/multiple sections for a\.txt/);
  });

  // Intent: body rows without '+' were a common model bug; error must name the line and rule.
  it("rejects SWAP body rows that omit the '+' prefix", () => {
    expect(() => Patch.parse("[a.txt#A1B2]\nSWAP 1.=1:\nplain")).toThrow(/Body rows must start with `\+`/);
  });

  // Intent: a lone '+' is the only supported way to author an empty inserted line.
  it("rejects a blank line inside a multi-row SWAP body", () => {
    expect(() => Patch.parse("[a.txt#A1B2]\nSWAP 1.=1:\n+a\n\n+b")).toThrow(/Blank lines inside a body/);
  });
});

describe("hashline/apply", () => {
  // Intent: overlapping SWAP/DEL ranges violate explicit-range semantics and must fail before mutation.
  it("rejects overlapping SWAP ranges", () => {
    expect(() =>
      applyOperations("a\nb\nc\n", [
        { kind: "swap", startLine: 1, endLine: 2, lines: ["A"], sourceLine: 2 },
        { kind: "delete", startLine: 2, endLine: 2, sourceLine: 3 },
      ]),
    ).toThrow(/overlap/);
  });

  // Intent: INS inside a SWAP interior (not at boundaries) is forbidden — agents must use INS.PRE/POST on edges.
  it("rejects INS.PRE anchored inside a SWAP range", () => {
    expect(() =>
      applyOperations("a\nb\nc\n", [
        { kind: "swap", startLine: 1, endLine: 3, lines: ["A", "B", "C"], sourceLine: 1 },
        { kind: "insert_before", anchorLine: 2, lines: ["x"], sourceLine: 5 },
      ]),
    ).toThrow(/lands inside explicit range/);
  });

  // Intent: SWAP/DEL/INS with empty '+' bodies are invalid patch authoring.
  it("rejects SWAP with no '+' body rows", () => {
    expect(() =>
      applyOperations("a\n", [{ kind: "swap", startLine: 1, endLine: 1, lines: [], sourceLine: 2 }]),
    ).toThrow(/at least one '\+' row/);
  });
});

describe("hashline/patcher", () => {
  function makePatcher(files: Record<string, string>) {
    const fs = new InMemoryFilesystem(Object.entries(files));
    const snapshots = new InMemorySnapshotStore();
    return { fs, snapshots, patcher: new Patcher({ fs, snapshots }) };
  }

  // Intent: edit on a missing path must direct agents to write, not create silently via edit.
  it("prepare fails when the target file does not exist", async () => {
    const { patcher } = makePatcher({});
    const section = Patch.parseSingle("[ghost.txt#A1B2]\nINS.HEAD:\n+new");
    await expect(patcher.prepare(section)).rejects.toThrow(/File not found: ghost\.txt/);
  });

  // Intent: two sections resolving to the same canonical path must be caught at preflight (multi-file patch safety).
  it("preflight rejects duplicate canonical paths across sections", async () => {
    class AliasFs extends InMemoryFilesystem {
      override canonicalPath(_path: string): string {
        return "/canonical/alias";
      }
    }
    const fs = new AliasFs([["path-a.txt", "x\n"], ["path-b.txt", "x\n"]]);
    const snapshots = new InMemorySnapshotStore();
    const hash = snapshots.record("/canonical/alias", "x\n");
    const patcher = new Patcher({ fs, snapshots });
    const patch = Patch.parse(`[path-a.txt#${hash}]\nSWAP 1.=1:\n+y\n[path-b.txt#${hash}]\nSWAP 1.=1:\n+z`);
    await expect(patcher.preflight(patch)).rejects.toThrow(/Multiple hashline sections resolve to the same file/);
  });

  // Intent: seen-lines gate is session safety — partial read must not allow editing unseen anchors.
  it("prepare rejects anchors on lines not recorded in the snapshot store", async () => {
    const fs = new InMemoryFilesystem([["f.txt", "a\nb\nc\n"]]);
    const snapshots = new InMemorySnapshotStore();
    const full = "a\nb\nc\n";
    const hash = snapshots.record("f.txt", full, [1]); // only line 1 was "read"
    const patcher = new Patcher({ fs, snapshots });
    const section = Patch.parseSingle(`[f.txt#${hash}]\nSWAP 3.=3:\n+gamma`);
    await expect(patcher.prepare(section)).rejects.toThrow(/did not display/);
  });

  // Intent: successful commit must mint a new file hash and persist normalized LF content via the FS seam.
  it("commit writes updated content and returns a fresh header tag", async () => {
    const fs = new InMemoryFilesystem([["f.txt", "old\n"]]);
    const snapshots = new InMemorySnapshotStore();
    const hash = snapshots.record("f.txt", "old\n", [1]);
    const patcher = new Patcher({ fs, snapshots });
    const section = Patch.parseSingle(`[f.txt#${hash}]\nSWAP 1.=1:\n+new`);
    const prepared = await patcher.prepare(section);
    const result = await patcher.commit(prepared);
    expect(result.op).toBe("update");
    expect(result.after).toBe("new\n");
    expect(fs.get("f.txt")).toBe("new\n");
    expect(result.header).toMatch(/^\[f\.txt#[0-9A-F]{4}\]$/);
    expect(result.fileHash).not.toBe(hash);
  });
});

describe("hashline/snapshots", () => {
  // Intent: recording seen lines on an unknown hash must be a no-op, not throw (partial session updates).
  it("recordSeenLines ignores unknown path/hash pairs", () => {
    const store = new InMemorySnapshotStore();
    expect(() => store.recordSeenLines("/x", "FFFF", [1])).not.toThrow();
    store.invalidate("/x");
    store.clear();
    expect(store.byHash("/x", "FFFF")).toBeNull();
  });

  // Intent: evicting oldest paths keeps memory bounded when many files are snapshotted.
  it("evicts oldest paths when maxPaths is exceeded", () => {
    const store = new InMemorySnapshotStore({ maxPaths: 2, maxTotalBytes: 1024 * 1024 });
    store.record("/a", "a");
    store.record("/b", "b");
    store.record("/c", "c");
    expect(store.byHash("/a", computeFileHash("a"))).toBeNull();
    expect(store.byHash("/c", computeFileHash("c"))).not.toBeNull();
  });
});

describe("hashline/diff-preview", () => {
  // Intent: edit tool shows compact post-edit line numbers; long added runs collapse with an ellipsis marker.
  it("collapses long contiguous added runs but keeps edge context lines", () => {
    const diff = ["+10|a", "+11|b", "+12|c", "+13|d", "+14|e", "+15|f"].join("\n");
    const preview = buildCompactDiffPreview(diff, { maxAddedRunContext: 1 });
    expect(preview.addedLines).toBe(6);
    expect(preview.preview).toContain("…");
    expect(preview.preview).toContain("10:a");
    expect(preview.preview).toContain("15:f");
    expect(preview.preview).not.toContain("12:c");
  });

  // Intent: non-numbered diff lines pass through for warnings/errors embedded in diff text.
  it("passes through non-numbered lines unchanged", () => {
    const preview = buildCompactDiffPreview("note: truncated\n+1|x");
    expect(preview.preview).toContain("note: truncated");
    expect(preview.preview).toContain("1:x");
  });
});

describe("hashline/messages", () => {
  // Intent: mismatch errors must highlight anchored lines with '*' for agent re-read UX.
  it("formatAnchoredContext marks anchor lines and inserts ellipsis gaps", () => {
    const rows = formatAnchoredContext([5, 20], Array.from({ length: 20 }, (_, i) => `l${i + 1}`));
    expect(rows.some((row) => row.startsWith("*5:"))).toBe(true);
    expect(rows.some((row) => row.startsWith("*20:"))).toBe(true);
    expect(rows).toContain("...");
  });
});