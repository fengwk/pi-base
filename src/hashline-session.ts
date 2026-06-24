import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { InMemorySnapshotStore } from "./hashline/index.js";
import { normalizeToLF } from "./hashline/normalize.js";

/** Snapshot store holds full normalized text for TAG validation; read display
 * limits (offset/limit, per-line chars) and seen-lines gate which lines may be edited. */
export const LARGE_FILE_NOTICE_BYTES = 4 * 1024 * 1024;

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

/** Read, normalize, and record a whole-file snapshot for hashline anchoring. */
export async function recordFileSnapshot(
  snapshots: InMemorySnapshotStore,
  absolutePath: string,
): Promise<string | undefined> {
  try {
    const normalized = normalizeToLF(await readFile(absolutePath, "utf8"));
    return snapshots.record(canonicalSnapshotKey(absolutePath), normalized);
  } catch {
    return undefined;
  }
}

/** Record already-known normalized text (read/write/edit paths). */
export function recordNormalizedSnapshot(
  snapshots: InMemorySnapshotStore,
  absolutePath: string,
  normalizedText: string,
  seenLines?: Iterable<number>,
): string {
  return snapshots.record(canonicalSnapshotKey(absolutePath), normalizedText, seenLines);
}