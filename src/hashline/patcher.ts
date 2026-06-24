import { applyOperations } from "./apply.js";
import { computeFileHash, formatHashlineHeader } from "./format.js";
import type { Filesystem, WriteResult } from "./fs.js";
import { isNotFound } from "./fs.js";
import type { Patch, PatchSection } from "./parser.js";
import { missingSnapshotTagMessage, unseenLinesMessage } from "./messages.js";
import { MismatchError } from "./mismatch.js";
import { detectLineEnding, type LineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./normalize.js";
import type { SnapshotStore } from "./snapshots.js";
import type { ApplyResult } from "./types.js";

export interface PatcherOptions {
  fs: Filesystem;
  snapshots: SnapshotStore;
}

export interface PatchSectionResult {
  path: string;
  canonicalPath: string;
  op: "create" | "update" | "noop";
  before: string;
  after: string;
  persisted: string;
  written: string;
  fileHash: string;
  header: string;
  firstChangedLine?: number;
  warnings: string[];
}

export interface PatcherApplyResult {
  sections: PatchSectionResult[];
}

export class PreparedSection {
  constructor(
    readonly section: PatchSection,
    readonly canonicalPath: string,
    readonly exists: boolean,
    readonly rawContent: string,
    readonly bom: string,
    readonly lineEnding: LineEnding,
    readonly normalized: string,
    readonly applyResult: ApplyResult,
  ) {}

  get isNoop(): boolean {
    return this.applyResult.text === this.normalized;
  }
}

function assertSectionHashPresent(sectionPath: string, fileHash: string | undefined): asserts fileHash is string {
  if (!fileHash) throw new Error(missingSnapshotTagMessage(sectionPath));
}

function assertUniqueCanonicalPaths(prepared: readonly PreparedSection[]): void {
  const seen = new Map<string, string>();
  for (const entry of prepared) {
    const previous = seen.get(entry.canonicalPath);
    if (previous !== undefined) {
      throw new Error(`Multiple hashline sections resolve to the same file (${previous} and ${entry.section.path}). Use one section header per file.`);
    }
    seen.set(entry.canonicalPath, entry.section.path);
  }
}

export class Patcher {
  readonly fs: Filesystem;
  readonly snapshots: SnapshotStore;

  constructor(options: PatcherOptions) {
    this.fs = options.fs;
    this.snapshots = options.snapshots;
  }

  async apply(patch: Patch): Promise<PatcherApplyResult> {
    const prepared: PreparedSection[] = [];
    for (const section of patch.sections) prepared.push(await this.prepare(section));
    assertUniqueCanonicalPaths(prepared);
    for (const preparedSection of prepared) {
      if (preparedSection.isNoop) {
        throw new Error(`Edits to ${preparedSection.section.path} resulted in no changes being made.`);
      }
    }
    const sections: PatchSectionResult[] = [];
    for (const preparedSection of prepared) sections.push(await this.commit(preparedSection));
    return { sections };
  }

  async preflight(patch: Patch): Promise<void> {
    const prepared: PreparedSection[] = [];
    for (const section of patch.sections) prepared.push(await this.prepare(section));
    assertUniqueCanonicalPaths(prepared);
    for (const preparedSection of prepared) {
      if (preparedSection.isNoop) {
        throw new Error(`Edits to ${preparedSection.section.path} resulted in no changes being made.`);
      }
    }
  }

  async prepare(section: PatchSection): Promise<PreparedSection> {
    assertSectionHashPresent(section.path, section.fileHash);

    const canonicalPath = this.fs.canonicalPath(section.path);
    await this.fs.preflightWrite(section.path);
    const { exists, rawContent } = await this.#tryRead(section.path);
    if (!exists) throw new Error(`File not found: ${section.path}. Use the write tool to create new files.`);

    const { bom, text } = stripBom(rawContent);
    const lineEnding = detectLineEnding(text);
    const normalized = normalizeToLF(text);
    const actualFileHash = computeFileHash(normalized);
    const expectedFileHash = section.fileHash;

    if (actualFileHash !== expectedFileHash) {
      this.#recordFullSnapshot(canonicalPath, normalized);
      throw this.#mismatchError(section, canonicalPath, normalized, expectedFileHash);
    }

    this.#assertSeenLines(section, canonicalPath, expectedFileHash);
    const applyResult = applyOperations(normalized, section.operations);
    return new PreparedSection(section, canonicalPath, exists, rawContent, bom, lineEnding, normalized, applyResult);
  }

  async commit(prepared: PreparedSection): Promise<PatchSectionResult> {
    const { section, canonicalPath, normalized, bom, lineEnding, rawContent, applyResult, exists } = prepared;
    const after = applyResult.text;
    const warnings = [...(section.warnings ?? []), ...(applyResult.warnings ?? [])];

    if (after === normalized) {
      const fileHash = this.#recordFullSnapshot(canonicalPath, normalized);
      return {
        path: section.path,
        canonicalPath,
        op: "noop",
        before: normalized,
        after: normalized,
        persisted: rawContent,
        written: rawContent,
        fileHash,
        header: formatHashlineHeader(section.path, fileHash),
        warnings,
      };
    }

    const persisted = bom + restoreLineEndings(after, lineEnding);
    const write: WriteResult = await this.fs.writeText(section.path, persisted);
    const fileHash = this.#recordFullSnapshot(canonicalPath, after);
    return {
      path: section.path,
      canonicalPath,
      op: exists ? "update" : "create",
      before: normalized,
      after,
      persisted,
      written: write.text,
      fileHash,
      header: formatHashlineHeader(section.path, fileHash),
      firstChangedLine: applyResult.firstChangedLine,
      warnings,
    };
  }

  async #tryRead(path: string): Promise<{ exists: boolean; rawContent: string }> {
    try {
      return { exists: true, rawContent: await this.fs.readText(path) };
    } catch (error) {
      if (isNotFound(error)) return { exists: false, rawContent: "" };
      throw error;
    }
  }

  #recordFullSnapshot(canonicalPath: string, normalized: string): string {
    return this.snapshots.record(canonicalPath, normalized);
  }

  #assertSeenLines(section: PatchSection, canonicalPath: string, expectedFileHash: string): void {
    const snapshot = this.snapshots.byHash(canonicalPath, expectedFileHash);
    const seen = snapshot?.seenLines;
    if (!seen || seen.size === 0) return;
    const unseen = section.collectAnchorLines().filter((line) => !seen.has(line));
    if (unseen.length > 0) throw new Error(unseenLinesMessage(section.path, unseen, expectedFileHash));
  }

  #mismatchError(section: PatchSection, canonicalPath: string, normalized: string, expectedFileHash: string): MismatchError {
    const actualFileHash = computeFileHash(normalized);
    return new MismatchError({
      path: section.path,
      expectedFileHash,
      actualFileHash,
      fileLines: normalized.length === 0 ? [] : normalized.split("\n").filter((_, index, lines) => !(index === lines.length - 1 && lines[index] === "")),
      anchorLines: section.collectAnchorLines(),
      hashRecognized: this.snapshots.byHash(canonicalPath, expectedFileHash) !== null,
    });
  }
}
