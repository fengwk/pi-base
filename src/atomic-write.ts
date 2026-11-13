import { randomBytes } from "node:crypto";
import { chmod, lstat, open, readlink, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Resolves the file a write must replace: a symlink keeps pointing at its target. */
async function resolveWriteTarget(targetPath: string): Promise<string> {
  try {
    if (!(await lstat(targetPath)).isSymbolicLink()) return targetPath;
  } catch {
    return targetPath;
  }
  try {
    return await realpath(targetPath);
  } catch {
    // A dangling symlink still names the path that a plain write would create.
    return resolve(dirname(targetPath), await readlink(targetPath));
  }
}

/**
 * Replaces `targetPath` atomically: a temporary file in the same directory is
 * filled, synced, given the original mode and renamed over the target, so a
 * crash or a full disk never leaves a truncated file behind. A symlinked
 * target keeps the link and replaces the file it resolves to.
 */
export async function writeFileAtomic(targetPath: string, data: Buffer): Promise<void> {
  const filePath = await resolveWriteTarget(targetPath);
  const existingMode = await stat(filePath).then((fileStat) => fileStat.mode, () => undefined);
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", existingMode ?? 0o666);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (existingMode !== undefined) await chmod(tempPath, existingMode);
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
