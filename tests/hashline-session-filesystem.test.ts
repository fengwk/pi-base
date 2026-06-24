import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiBaseHashlineFilesystem } from "../src/hashline-filesystem.js";
import {
  canonicalSnapshotKey,
  recordFileSnapshot,
  recordNormalizedSnapshot,
} from "../src/hashline-session.js";
import { InMemorySnapshotStore } from "../src/hashline/index.js";

describe("hashline-session", () => {
  // Intent: snapshot keys must be stable for the same real path so read/edit share one store entry.
  it("canonicalSnapshotKey returns a stable absolute key for an existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-base-snap-"));
    try {
      const file = join(root, "src", "a.ts");
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(file, "x", "utf8");
      const first = canonicalSnapshotKey(file);
      const second = canonicalSnapshotKey(file);
      expect(first).toBe(second);
      expect(first).toContain("a.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Intent: recordFileSnapshot must still mint a tag for oversized files (no byte cap on anchoring).
  it("recordFileSnapshot records oversized files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-base-big-"));
    try {
      const file = join(root, "big.txt");
      const payload = `${"x".repeat(4 * 1024 * 1024 + 64)}\nline2\n`;
      await writeFile(file, payload, "utf8");
      const store = new InMemorySnapshotStore();
      const tag = await recordFileSnapshot(store, file);
      expect(tag).toMatch(/^[0-9A-F]{4}$/);
      expect(store.head(canonicalSnapshotKey(file))?.text).toContain("line2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Intent: write/edit paths record normalized snapshots with optional seen line sets for partial reads.
  it("recordNormalizedSnapshot stores content and seen lines under the canonical key", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-base-norm-"));
    try {
      const file = join(root, "f.txt");
      const store = new InMemorySnapshotStore();
      const hash = recordNormalizedSnapshot(store, file, "a\nb\n", [1, 2]);
      const snap = store.byHash(canonicalSnapshotKey(file), hash);
      expect(snap?.text).toBe("a\nb\n");
      expect(snap?.seenLines?.has(2)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Intent: missing paths during snapshot read must not throw through the read tool stack.
  it("recordFileSnapshot returns undefined when the file cannot be read", async () => {
    const store = new InMemorySnapshotStore();
    expect(await recordFileSnapshot(store, join(tmpdir(), "definitely-missing-pi-base-file.txt"))).toBeUndefined();
  });
});

describe("hashline-filesystem", () => {
  // Intent: PiBase adapter resolves workdir-relative paths and surfaces ENOENT as NotFoundError for patcher.
  it("readText throws NotFoundError for missing relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-base-hlf-"));
    try {
      const fs = new PiBaseHashlineFilesystem({ cwd: root });
      await expect(fs.readText("missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.exists("missing.txt")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Intent: writes must create parent dirs and invoke onWrite so extension can refresh snapshots after commit.
  it("writeText creates parents, persists content, and calls onWrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-base-hlfw-"));
    try {
      let written: { absolute: string; text: string } | undefined;
      const fs = new PiBaseHashlineFilesystem({
        cwd: root,
        onWrite: (absolutePath, text) => {
          written = { absolute: absolutePath, text };
        },
      });
      const result = await fs.writeText("deep/nested.txt", "payload");
      expect(result.text).toBe("payload");
      expect(written?.text).toBe("payload");
      expect(written?.absolute).toBe(join(root, "deep", "nested.txt"));
      expect(await fs.readText("deep/nested.txt")).toBe("payload");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Intent: abort signal must propagate so cancelled edit tool calls do not keep writing.
  it("writeText respects an aborted signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-base-abort-"));
    try {
      const controller = new AbortController();
      controller.abort();
      const fs = new PiBaseHashlineFilesystem({ cwd: root, signal: controller.signal });
      await expect(fs.writeText("x.txt", "y")).rejects.toThrow(/aborted/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});