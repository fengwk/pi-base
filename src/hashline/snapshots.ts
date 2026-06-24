import { computeFileHash } from "./format.js";

/** One recorded full-file snapshot bound to a hashline `[path#TAG]` header. */
export interface Snapshot {
  readonly path: string;
  readonly text: string;
  readonly hash: string;
  recordedAt: number;
  /** 1-indexed file lines that a read actually displayed under this tag. */
  seenLines?: Set<number>;
}

/** Minimal store interface used by read/write/edit to mint and validate tags. */
export abstract class SnapshotStore {
  abstract head(path: string): Snapshot | null;
  abstract byHash(path: string, hash: string): Snapshot | null;
  abstract record(path: string, fullText: string, seenLines?: Iterable<number>): string;
  abstract recordSeenLines(path: string, hash: string, lines: Iterable<number>): void;
  abstract invalidate(path: string): void;
  abstract clear(): void;
}

const DEFAULT_MAX_PATHS = 30;
const DEFAULT_MAX_VERSIONS_PER_PATH = 4;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function mergeSeenLines(snapshot: Snapshot, lines: Iterable<number> | undefined): void {
  if (lines === undefined) return;
  if (snapshot.seenLines === undefined) snapshot.seenLines = new Set<number>();
  for (const line of lines) snapshot.seenLines.add(line);
}

export interface InMemorySnapshotStoreOptions {
  maxPaths?: number;
  maxVersionsPerPath?: number;
  maxTotalBytes?: number;
}

function historySize(history: readonly Snapshot[]): number {
  let total = 1;
  for (const snapshot of history) total += snapshot.text.length;
  return total;
}

/** Simple in-memory LRU snapshot store for one agent session. */
export class InMemorySnapshotStore extends SnapshotStore {
  readonly #versions = new Map<string, Snapshot[]>();
  readonly #maxPaths: number;
  readonly #maxVersionsPerPath: number;
  readonly #maxTotalBytes: number;

  constructor(options: InMemorySnapshotStoreOptions = {}) {
    super();
    this.#maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
    this.#maxVersionsPerPath = options.maxVersionsPerPath ?? DEFAULT_MAX_VERSIONS_PER_PATH;
    this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  head(path: string): Snapshot | null {
    return this.#versions.get(path)?.[0] ?? null;
  }

  byHash(path: string, hash: string): Snapshot | null {
    return this.#versions.get(path)?.find((snapshot) => snapshot.hash === hash) ?? null;
  }

  record(path: string, fullText: string, seenLines?: Iterable<number>): string {
    const hash = computeFileHash(fullText);
    const history = this.#versions.get(path) ?? [];
    const existing = history.find((snapshot) => snapshot.hash === hash);
    if (existing) {
      existing.recordedAt = Date.now();
      mergeSeenLines(existing, seenLines);
      const nextHistory = history[0] === existing ? history : [existing, ...history.filter((snapshot) => snapshot !== existing)];
      this.#touch(path, nextHistory);
      this.#evict();
      return hash;
    }

    const snapshot: Snapshot = { path, text: fullText, hash, recordedAt: Date.now() };
    mergeSeenLines(snapshot, seenLines);
    this.#touch(path, [snapshot, ...history].slice(0, this.#maxVersionsPerPath));
    this.#evict();
    return hash;
  }

  recordSeenLines(path: string, hash: string, lines: Iterable<number>): void {
    const snapshot = this.byHash(path, hash);
    if (!snapshot) return;
    mergeSeenLines(snapshot, lines);
    const history = this.#versions.get(path);
    if (history) this.#touch(path, history);
  }

  invalidate(path: string): void {
    this.#versions.delete(path);
  }

  clear(): void {
    this.#versions.clear();
  }

  #touch(path: string, history: Snapshot[]): void {
    this.#versions.delete(path);
    this.#versions.set(path, history);
  }

  #totalBytes(): number {
    let total = 0;
    for (const history of this.#versions.values()) total += historySize(history);
    return total;
  }

  #evict(): void {
    while (this.#versions.size > this.#maxPaths || this.#totalBytes() > this.#maxTotalBytes) {
      const oldest = this.#versions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#versions.delete(oldest);
    }
  }
}
