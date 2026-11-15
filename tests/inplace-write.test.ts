import { chmod, link, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

function tools() {
  const registry = createToolRegistry();
  piBaseExtension(registry.pi as never);
  return registry;
}

async function run(registry: ReturnType<typeof tools>, name: string, cwd: string, args: Record<string, unknown>) {
  return registry.getTool(name).execute("inplace", { workdir: ".", ...args }, undefined, undefined, { cwd });
}

describe.skipIf(process.platform === "win32")("in-place writes", () => {
  it("keeps the inode so hardlinks see edit and write results", async () => {
    // Intent: an in-place rewrite must mutate the existing inode instead of
    // renaming a temporary file, so every hardlink keeps the new content.
    const root = await createTempWorkspace();
    try {
      const file = join(root, "a.txt");
      const hardlink = join(root, "b.txt");
      await writeFile(file, "alpha\n");
      await link(file, hardlink);
      const before = await stat(file);
      const registry = tools();

      const edit = await run(registry, "edit", root, { path: "a.txt", edits: [{ old_string: "alpha", new_string: "beta" }] });
      expect(edit.isError).not.toBe(true);
      expect((await stat(file)).ino).toBe(before.ino);
      expect(await readFile(hardlink, "utf8")).toBe("beta\n");

      const write = await run(registry, "write", root, { path: "a.txt", content: "gamma\n" });
      expect(write.isError).not.toBe(true);
      expect((await stat(file)).ino).toBe(before.ino);
      expect(await readFile(hardlink, "utf8")).toBe("gamma\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("follows a symlink without replacing the link", async () => {
    // Intent: writing through a symlink must update its target in place and keep
    // the symlink itself, matching ordinary fs.writeFile semantics.
    const root = await createTempWorkspace();
    try {
      const target = join(root, "target.txt");
      const symlinkPath = join(root, "link.txt");
      await writeFile(target, "alpha\n");
      await symlink(target, symlinkPath);
      const before = await stat(target);
      const registry = tools();

      const edit = await run(registry, "edit", root, { path: "link.txt", edits: [{ old_string: "alpha", new_string: "beta" }] });
      expect(edit.isError).not.toBe(true);
      expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);
      expect((await stat(target)).ino).toBe(before.ino);
      expect(await readFile(target, "utf8")).toBe("beta\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes a writable file inside a read-only directory", async () => {
    // Intent: no temporary file is needed, so a directory without write permission
    // must not prevent edit or write from updating an existing writable file.
    const root = await createTempWorkspace();
    const directory = join(root, "data");
    await mkdir(directory);
    const file = join(directory, "file.txt");
    await writeFile(file, "alpha\n");
    await chmod(file, 0o644);
    await chmod(directory, 0o555);
    try {
      const registry = tools();

      const write = await run(registry, "write", root, { path: "data/file.txt", content: "beta\n" });
      expect(write.isError).not.toBe(true);
      expect(await readFile(file, "utf8")).toBe("beta\n");

      const edit = await run(registry, "edit", root, { path: "data/file.txt", edits: [{ old_string: "beta", new_string: "gamma" }] });
      expect(edit.isError).not.toBe(true);
      expect(await readFile(file, "utf8")).toBe("gamma\n");
    } finally {
      await chmod(directory, 0o755);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the file mode and leaves an unwritable file unchanged", async () => {
    // Intent: truncating the target keeps its permission bits, and a rejected
    // write must not leave partial content behind.
    const root = await createTempWorkspace();
    try {
      const file = join(root, "mode.txt");
      await writeFile(file, "alpha\n");
      await chmod(file, 0o640);
      const registry = tools();

      const write = await run(registry, "write", root, { path: "mode.txt", content: "beta\n" });
      expect(write.isError).not.toBe(true);
      expect((await stat(file)).mode & 0o777).toBe(0o640);
      expect(await readFile(file, "utf8")).toBe("beta\n");

      if (process.getuid?.() === 0) return;
      await chmod(file, 0o444);
      const rejected = await run(registry, "edit", root, { path: "mode.txt", edits: [{ old_string: "beta", new_string: "gamma" }] });
      expect(rejected.isError).toBe(true);
      expect(getText(rejected)).toContain("EACCES");
      expect(await readFile(file, "utf8")).toBe("beta\n");
    } finally {
      await chmod(join(root, "mode.txt"), 0o640).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
