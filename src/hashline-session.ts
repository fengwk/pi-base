import { realpathSync } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { InMemorySnapshotStore } from "./hashline/index.js";
import { normalizeToLF } from "./hashline/normalize.js";

/** Upper bound on the file size we snapshot during read. A hashline tag names
 * the whole normalized file content, so minting one means holding that content
 * in memory. Large files still read, but they omit the `[path#tag]` header. */
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

/** Canonicalize an absolute path into the stable key the snapshot store uses. */
export function canonicalSnapshotKey(absolutePath: string): string {
  try {
    return realpathSync.native(absolutePath);
  } catch {
    try {
      const parent = realpathSync.native(dirname(absolutePath));
      return join(parent, basename(absolutePath));
    } catch {
      return absolutePath;
    }
  }
}

/** Read, normalize, and record a whole-file snapshot if it is small enough. */
export async function recordFileSnapshot(
  snapshots: InMemorySnapshotStore,
  absolutePath: string,
): Promise<string | undefined> {
  try {
    const fileStat = await stat(absolutePath);
    if (fileStat.size > SNAPSHOT_MAX_BYTES) return undefined;
    const normalized = normalizeToLF(await readFile(absolutePath, "utf8"));
    return snapshots.record(canonicalSnapshotKey(absolutePath), normalized);
  } catch {
    return undefined;
  }
}

/** Record already-known normalized text, bypassing the read-size guard. */
export function recordNormalizedSnapshot(
  snapshots: InMemorySnapshotStore,
  absolutePath: string,
  normalizedText: string,
  seenLines?: Iterable<number>,
): string {
  return snapshots.record(canonicalSnapshotKey(absolutePath), normalizedText, seenLines);
}
