import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/atomic-write.js";

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-base-atomic-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("atomic write", () => {
  it("replaces the target in a single rename and leaves no temporary file behind", async () => {
    // Intent: the commit must never expose a partially written target and must
    // clean up the temporary file it creates.
    await withTempDir(async (root) => {
      const file = join(root, "a.txt");
      await writeFile(file, "old\n");

      await writeFileAtomic(file, Buffer.from("new\n"));

      expect(await readFile(file, "utf8")).toBe("new\n");
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });

  it.skipIf(process.platform === "win32")("keeps the original file mode", async () => {
    // Intent: a rewrite must not silently widen or narrow the target's permissions.
    await withTempDir(async (root) => {
      const file = join(root, "a.txt");
      await writeFile(file, "old\n");
      await chmod(file, 0o640);

      await writeFileAtomic(file, Buffer.from("new\n"));

      expect((await stat(file)).mode & 0o777).toBe(0o640);
    });
  });

  it.skipIf(process.platform === "win32")("replaces the file a symlink points at and keeps the link", async () => {
    // Intent: editing through a symlink must not replace the link with a regular file.
    await withTempDir(async (root) => {
      const target = join(root, "target.txt");
      const link = join(root, "link.txt");
      await writeFile(target, "old\n");
      await symlink(target, link);

      await writeFileAtomic(link, Buffer.from("new\n"));

      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, "utf8")).toBe("new\n");
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });
});
