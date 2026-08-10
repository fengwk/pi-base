import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { chmod, lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseLineEndingDocument, serializeLineEndingDocument, type ConcreteLineEnding } from "./line-endings.js";
import { resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";
import { decodeTextFile, encodeTextFile } from "./text-codec.js";

export type ApplyPatchOperation = "add" | "update" | "delete";

export interface ApplyPatchChunkLine {
  kind: "context" | "delete" | "add";
  text: string;
}

export interface ApplyPatchChunk {
  changeContext?: string;
  lines: ApplyPatchChunkLine[];
  endOfFile: boolean;
}

export interface ApplyPatchAddFile {
  operation: "add";
  path: string;
  lines: string[];
}

export interface ApplyPatchUpdateFile {
  operation: "update";
  path: string;
  moveTo?: string;
  chunks: ApplyPatchChunk[];
}

export interface ApplyPatchDeleteFile {
  operation: "delete";
  path: string;
}

export type ApplyPatchFile = ApplyPatchAddFile | ApplyPatchUpdateFile | ApplyPatchDeleteFile;

export interface ParsedApplyPatch {
  /** Optional freeform `*** Workdir:` header; defaults to session cwd when omitted. */
  workdir?: string;
  files: ApplyPatchFile[];
}

export interface ApplyPatchIntent {
  operation: ApplyPatchOperation;
  path: string;
  moveTo?: string;
}

export interface ApplyPatchExecutionOptions {
  cwd?: string;
  signal?: AbortSignal;
  onCommitted?: (result: ApplyPatchFileResult) => void | Promise<void>;
  onCommitFailed?: (failure: ApplyPatchCommitFailure) => void | Promise<void>;
}

export interface ApplyPatchCommitFailure {
  operation: ApplyPatchOperation;
  path: string;
  absolutePath: string;
  moveTo?: string;
  absoluteMoveToPath?: string;
  state: "unknown";
}

export interface ApplyPatchFileResult {
  operation: ApplyPatchOperation;
  path: string;
  absolutePath: string;
  moveTo?: string;
  absoluteMoveToPath?: string;
  before: string | null;
  after: string | null;
}

export interface ApplyPatchExecutionResult {
  files: ApplyPatchFileResult[];
}

export class ApplyPatchCommitError extends Error {
  readonly failedPath: string;
  readonly failedTarget: string;
  readonly failedAbsolutePath?: string;
  readonly failedMoveTo?: string;
  readonly failedAbsoluteMoveToPath?: string;
  readonly failedPathState = "unknown" as const;
  readonly causeMessage: string;
  readonly appliedPaths: string[];
  readonly appliedFiles: ApplyPatchFileResult[];

  constructor(failure: string | ApplyPatchCommitFailure, appliedFiles: ApplyPatchFileResult[], cause: unknown) {
    const failedPath = typeof failure === "string" ? failure : failure.path;
    const failedMoveTo = typeof failure === "string" ? undefined : failure.moveTo;
    const failedTarget = failedMoveTo === undefined ? failedPath : `${failedPath} -> ${failedMoveTo}`;
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    const appliedPaths = appliedFiles.map((file) => file.path);
    const applied = appliedPaths.length === 0
      ? "No patch files were applied."
      : `Already applied: ${appliedPaths.join(", ")}.`;
    super(`Failed to apply patch for ${failedTarget}. ${applied} Cause: ${causeMessage}`, { cause });
    this.name = "ApplyPatchCommitError";
    this.failedPath = failedPath;
    this.failedTarget = failedTarget;
    if (typeof failure !== "string") {
      this.failedAbsolutePath = failure.absolutePath;
      this.failedMoveTo = failure.moveTo;
      this.failedAbsoluteMoveToPath = failure.absoluteMoveToPath;
    }
    this.causeMessage = causeMessage;
    this.appliedPaths = appliedPaths;
    this.appliedFiles = appliedFiles.map((file) => ({ ...file }));
  }
}

interface LineRecord {
  text: string;
  eol: ConcreteLineEnding | null;
}

interface BaseMutationPlan {
  operation: ApplyPatchOperation;
  path: string;
  absolutePath: string;
  before: string | null;
  after: string | null;
}

interface AddMutationPlan extends BaseMutationPlan {
  operation: "add";
  outputBytes: Buffer;
}

interface UpdateMutationPlan extends BaseMutationPlan {
  operation: "update";
  moveTo?: string;
  absoluteMoveToPath?: string;
  expectedMoveToBytes?: Buffer | null;
  sourceMode?: number;
  expectedBytes: Buffer;
  outputBytes: Buffer;
}

interface DeleteMutationPlan extends BaseMutationPlan {
  operation: "delete";
  expectedBytes: Buffer;
}

type MutationPlan = AddMutationPlan | UpdateMutationPlan | DeleteMutationPlan;
type MatchLevel = "exact" | "trimEnd" | "trim" | "unicode";

const FILE_DIRECTIVE_PREFIXES = ["*** Add File:", "*** Update File:", "*** Delete File:"] as const;
const WORKDIR_PREFIX = "*** Workdir:";

function normalizePatchText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function trimSurroundingBlankLines(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  while (end - start > 1 && lines[start]!.trim() === "") start++;
  while (end - start > 1 && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

function stripHeredocWrapper(text: string): string {
  const lines = text.split("\n");
  const first = lines[0]!.trim();
  const match = /^(?:cat\s+)?<<(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))$/.exec(first);
  if (!match) return text;

  const delimiter = match[1] ?? match[2] ?? match[3]!;
  let closingIndex = lines.length - 1;
  while (closingIndex > 0 && lines[closingIndex] === "") closingIndex--;
  if (!lines[closingIndex]!.startsWith(delimiter) || !/^[\t ]*$/.test(lines[closingIndex]!.slice(delimiter.length))) {
    throw new Error(`Malformed apply_patch heredoc: missing closing ${delimiter}.`);
  }
  return lines.slice(1, closingIndex).join("\n");
}

function isPatchMarker(line: string, marker: string): boolean {
  const index = line.indexOf(marker);
  return index !== -1
    && /^[\t ]*$/.test(line.slice(0, index))
    && line.slice(index, index + marker.length) === marker
    && /^[\t ]*$/.test(line.slice(index + marker.length));
}

function isPaddedFileDirective(line: string): boolean {
  const trimmed = line.trim();
  return FILE_DIRECTIVE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function isTopLevelPatchDirective(line: string): boolean {
  const trimmed = line.trim();
  return isPaddedFileDirective(line)
    || trimmed.startsWith(WORKDIR_PREFIX)
    || isPatchMarker(line, "*** End Patch");
}

function isUpdateFileBoundary(line: string): boolean {
  // Any leading space is Update context syntax; tab-only padding is unambiguous.
  return !line.startsWith(" ") && isPaddedFileDirective(line);
}

function isUpdatePatchEnd(line: string): boolean {
  // A leading space is Update context syntax; tab-only padding remains unambiguous.
  return !line.startsWith(" ") && isPatchMarker(line, "*** End Patch");
}

function parseRequiredPath(line: string, prefix: string): string {
  const path = line.slice(prefix.length).trim();
  if (path.length === 0) throw new Error(`${prefix.slice(4, -1)} path must not be empty.`);
  return path;
}

function assertUniquePath(path: string, seenPaths: Set<string>): void {
  if (seenPaths.has(path)) throw new Error(`Duplicate patch path: ${path}.`);
  seenPaths.add(path);
}

export function parseApplyPatch(patchText: string): ParsedApplyPatch {
  const normalized = normalizePatchText(patchText);
  const unwrapped = stripHeredocWrapper(trimSurroundingBlankLines(normalized));
  const lines = trimSurroundingBlankLines(unwrapped).split("\n");
  if (!isPatchMarker(lines[0]!, "*** Begin Patch")) {
    throw new Error("Patch must start with *** Begin Patch.");
  }

  const files: ApplyPatchFile[] = [];
  const seenPaths = new Set<string>();
  let index = 1;
  let foundEnd = false;
  let workdir: string | undefined;

  // Optional freeform workdir header must sit immediately after Begin Patch.
  if (index < lines.length) {
    const maybeWorkdir = lines[index]!.trim();
    if (maybeWorkdir.startsWith(WORKDIR_PREFIX)) {
      workdir = parseRequiredPath(maybeWorkdir, WORKDIR_PREFIX);
      index++;
    }
  }

  while (index < lines.length) {
    const line = lines[index]!;
    if (isPatchMarker(line, "*** End Patch")) {
      foundEnd = true;
      index++;
      break;
    }
    const directiveLine = line.trim();

    if (directiveLine.startsWith(WORKDIR_PREFIX)) {
      throw new Error("*** Workdir: is only allowed immediately after *** Begin Patch.");
    }

    if (directiveLine.startsWith("*** Add File:")) {
      const path = parseRequiredPath(directiveLine, "*** Add File:");
      assertUniquePath(path, seenPaths);
      index++;
      const content: string[] = [];
      while (index < lines.length && !isTopLevelPatchDirective(lines[index]!)) {
        const bodyLine = lines[index]!;
        if (!bodyLine.startsWith("+")) {
          throw new Error(`Malformed Add File body for ${path}: every line must start with +.`);
        }
        content.push(bodyLine.slice(1));
        index++;
      }
      files.push({ operation: "add", path, lines: content });
      continue;
    }

    if (directiveLine.startsWith("*** Delete File:")) {
      const path = parseRequiredPath(directiveLine, "*** Delete File:");
      assertUniquePath(path, seenPaths);
      index++;
      if (index < lines.length && !isTopLevelPatchDirective(lines[index]!)) {
        throw new Error(`Delete File ${path} must not have a body.`);
      }
      files.push({ operation: "delete", path });
      continue;
    }

    if (directiveLine.startsWith("*** Update File:")) {
      const path = parseRequiredPath(directiveLine, "*** Update File:");
      assertUniquePath(path, seenPaths);
      index++;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to:")) {
        moveTo = parseRequiredPath(lines[index]!, "*** Move to:");
        assertUniquePath(moveTo, seenPaths);
        index++;
      }

      const chunks: ApplyPatchChunk[] = [];
      while (index < lines.length && !isUpdatePatchEnd(lines[index]!) && !isUpdateFileBoundary(lines[index]!)) {
        const chunkHeader = lines[index]!;
        if (!chunkHeader.startsWith("@@")) {
          throw new Error(`Malformed Update File ${path}: expected an @@ chunk, got ${chunkHeader}.`);
        }
        const rawChangeContext = chunkHeader.slice(2).trim();
        const changeContext = rawChangeContext.length === 0 ? undefined : rawChangeContext;
        index++;

        const chunkLines: ApplyPatchChunkLine[] = [];
        let endOfFile = false;
        while (index < lines.length && !isUpdatePatchEnd(lines[index]!) && !isUpdateFileBoundary(lines[index]!) && !lines[index]!.startsWith("@@")) {
          const bodyLine = lines[index]!;
          if (bodyLine === "*** End of File") {
            endOfFile = true;
            index++;
            if (index < lines.length && !isUpdatePatchEnd(lines[index]!) && !isUpdateFileBoundary(lines[index]!)) {
              throw new Error(`Malformed Update File ${path}: *** End of File must end the update.`);
            }
            break;
          }
          const marker = bodyLine[0];
          if (marker !== " " && marker !== "-" && marker !== "+") {
            throw new Error(`Malformed Update File ${path}: lines must start with space, -, or +.`);
          }
          chunkLines.push({
            kind: marker === " " ? "context" : marker === "-" ? "delete" : "add",
            text: bodyLine.slice(1),
          });
          index++;
        }
        if (chunkLines.length === 0) throw new Error(`Malformed Update File ${path}: chunk must contain at least one line.`);
        chunks.push({ changeContext, lines: chunkLines, endOfFile });
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Error(`Update File ${path} must contain at least one @@ chunk.`);
      files.push({ operation: "update", path, ...(moveTo === undefined ? {} : { moveTo }), chunks });
      continue;
    }

    throw new Error(`Unknown patch line: ${line}.`);
  }

  if (!foundEnd) throw new Error("Patch must end with *** End Patch.");
  while (index < lines.length && lines[index] === "") index++;
  if (index !== lines.length) throw new Error(`Unknown patch line after *** End Patch: ${lines[index]}.`);
  if (files.length === 0) throw new Error("Patch must contain at least one file operation.");
  return workdir === undefined ? { files } : { workdir, files };
}

export function getApplyPatchIntents(patch: ParsedApplyPatch): ApplyPatchIntent[] {
  return patch.files.map((file) => ({
    operation: file.operation,
    path: file.path,
    ...(file.operation === "update" && file.moveTo !== undefined ? { moveTo: file.moveTo } : {}),
  }));
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function mutationPathKey(absolutePath: string): string {
  return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
}

function normalizeUnicodePunctuation(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, "\"")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

function normalizeForMatch(value: string, level: MatchLevel): string {
  if (level === "exact") return value;
  if (level === "trimEnd") return value.trimEnd();
  if (level === "trim") return value.trim();
  return normalizeUnicodePunctuation(value).trim();
}

function findMatches(
  haystack: readonly string[],
  needle: readonly string[],
  startIndex: number,
  endOfFile: boolean,
  level: MatchLevel,
): number[] {
  const matches: number[] = [];
  const lastStart = haystack.length - needle.length;
  for (let index = startIndex; index <= lastStart; index++) {
    if (endOfFile && index + needle.length !== haystack.length) continue;
    let matched = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (normalizeForMatch(haystack[index + offset]!, level) !== normalizeForMatch(needle[offset]!, level)) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push(index);
  }
  return matches;
}

function tryFindUniqueMatch(
  path: string,
  description: string,
  haystack: readonly string[],
  needle: readonly string[],
  startIndex: number,
  endOfFile = false,
): number | undefined {
  const levels: readonly MatchLevel[] = ["exact", "trimEnd", "trim", "unicode"];
  for (const level of levels) {
    const matches = findMatches(haystack, needle, startIndex, endOfFile, level);
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      throw new Error(`${path}: ${description} is ambiguous at ${level} matching (${matches.length} matches).`);
    }
    return matches[0]!;
  }
  return undefined;
}

function findUniqueMatch(
  path: string,
  description: string,
  haystack: readonly string[],
  needle: readonly string[],
  startIndex: number,
  endOfFile = false,
): number {
  const match = tryFindUniqueMatch(path, description, haystack, needle, startIndex, endOfFile);
  if (match === undefined) throw new Error(`${path}: could not match ${description}.`);
  return match;
}

function projectTrailingEmptyCompatibilityLines(lines: readonly ApplyPatchChunkLine[]): ApplyPatchChunkLine[] {
  const projected = lines.map((line) => ({
    text: line.text,
    inOld: line.kind !== "add",
    inNew: line.kind !== "delete",
  }));
  let oldIndex = -1;
  let newIndex = -1;
  for (let index = projected.length - 1; index >= 0; index--) {
    if (projected[index]!.inOld) {
      oldIndex = index;
      break;
    }
  }
  for (let index = projected.length - 1; index >= 0; index--) {
    if (projected[index]!.inNew) {
      newIndex = index;
      break;
    }
  }

  // OpenCode drops the trailing old/new entries independently. A context line
  // belongs to both sides, so dropping it from only one side must convert it to
  // an addition or deletion rather than removing the whole line.
  if (oldIndex !== -1) projected[oldIndex]!.inOld = false;
  if (newIndex !== -1 && projected[newIndex]!.text === "") projected[newIndex]!.inNew = false;

  const result: ApplyPatchChunkLine[] = [];
  for (const line of projected) {
    if (!line.inOld && !line.inNew) continue;
    result.push({
      kind: line.inOld ? (line.inNew ? "context" : "delete") : "add",
      text: line.text,
    });
  }
  return result;
}

function toLineRecords(text: string): { records: LineRecord[]; defaultEnding: ConcreteLineEnding } {
  if (text.length === 0) return { records: [], defaultEnding: "\n" };
  const document = parseLineEndingDocument(text);
  const records = document.lines.map((line, index) => ({ text: line, eol: document.eolAfter[index]! }));
  if (records.length > 1 && records[records.length - 1]!.text === "" && records[records.length - 1]!.eol === null) {
    records.pop();
  }
  return { records, defaultEnding: document.defaultEnding };
}

function chooseInsertedEnding(
  matched: readonly LineRecord[],
  replacementOffset: number,
  records: readonly LineRecord[],
  insertionIndex: number,
  defaultEnding: ConcreteLineEnding,
): ConcreteLineEnding {
  return matched[Math.min(replacementOffset, matched.length - 1)]?.eol
    ?? records[insertionIndex + replacementOffset]?.eol
    ?? records[insertionIndex - 1]?.eol
    ?? defaultEnding;
}

function applyUpdate(path: string, text: string, chunks: readonly ApplyPatchChunk[]): string {
  const { records, defaultEnding } = toLineRecords(text);
  const preserveMissingFinalEnding = records.length > 0 && records[records.length - 1]!.eol === null;
  const originalTexts = records.map((record) => record.text);
  let sourceRegionEnd = records.length;
  let cursor = 0;
  let mutationLineCount = 0;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex]!;
    const sourceTexts = records.slice(0, sourceRegionEnd).map((record) => record.text);
    let lines = chunk.lines;
    let oldLines = lines.filter((line) => line.kind !== "add").map((line) => line.text);

    let searchStart = cursor;
    if (chunk.changeContext !== undefined) {
      const contextIndex = findUniqueMatch(
        path,
        `change context for chunk ${chunkIndex + 1}`,
        sourceTexts,
        [chunk.changeContext],
        cursor,
      );
      searchStart = contextIndex + 1;
    }

    let matchIndex: number;
    if (oldLines.length === 0) {
      matchIndex = records.length;
    } else {
      const description = `old lines for chunk ${chunkIndex + 1}`;
      const match = tryFindUniqueMatch(
        path,
        description,
        sourceTexts,
        oldLines,
        searchStart,
        chunk.endOfFile,
      );
      if (match !== undefined) {
        matchIndex = match;
      } else if (oldLines.length > 1 && oldLines[oldLines.length - 1] === "") {
        const compatibilityLines = projectTrailingEmptyCompatibilityLines(lines);
        const compatibilityOldLines = compatibilityLines
          .filter((line) => line.kind !== "add")
          .map((line) => line.text);
        const compatibilityMatch = tryFindUniqueMatch(
          path,
          description,
          sourceTexts,
          compatibilityOldLines,
          searchStart,
          chunk.endOfFile,
        );
        if (compatibilityMatch === undefined) throw new Error(`${path}: could not match ${description}.`);
        lines = compatibilityLines;
        oldLines = compatibilityOldLines;
        matchIndex = compatibilityMatch;
      } else {
        throw new Error(`${path}: could not match ${description}.`);
      }
    }

    mutationLineCount += lines.filter((line) => line.kind !== "context").length;
    const matched = records.slice(matchIndex, matchIndex + oldLines.length);
    const replacement: LineRecord[] = [];
    let oldOffset = 0;
    for (const line of lines) {
      if (line.kind === "context") {
        replacement.push(matched[oldOffset]!);
        oldOffset++;
      } else if (line.kind === "delete") {
        oldOffset++;
      } else {
        replacement.push({
          text: line.text,
          eol: chooseInsertedEnding(matched, replacement.length, records, matchIndex, defaultEnding),
        });
      }
    }
    records.splice(matchIndex, oldLines.length, ...replacement);
    if (oldLines.length === 0) {
      // OpenCode appends insertion-only chunks at EOF. Those appended records are
      // outside the source region and cannot satisfy later context or old-line matches.
      cursor = searchStart;
    } else {
      sourceRegionEnd += replacement.length - oldLines.length;
      cursor = matchIndex + replacement.length;
    }
  }

  if (mutationLineCount === 0) throw new Error(`${path}: update contains no added or deleted lines.`);
  const nextTexts = records.map((record) => record.text);
  if (nextTexts.length === originalTexts.length && nextTexts.every((line, index) => line === originalTexts[index])) {
    throw new Error(`${path}: update would make no changes.`);
  }
  // A former unterminated final line can become internal after append/replacement;
  // give internal records a concrete separator while preserving the file's original
  // final-termination state on the new last record.
  for (let index = 0; index < records.length - 1; index++) {
    const record = records[index]!;
    record.eol ??= records[index + 1]?.eol ?? records[index - 1]?.eol ?? defaultEnding;
  }
  if (records.length > 0) {
    const last = records[records.length - 1]!;
    if (preserveMissingFinalEnding) last.eol = null;
    else last.eol ??= records[records.length - 2]?.eol ?? defaultEnding;
  }
  return serializeLineEndingDocument({
    lines: records.map((record) => record.text),
    eolAfter: records.map((record) => record.eol),
  });
}

async function assertAddParentIsDirectory(absolutePath: string, signal?: AbortSignal): Promise<void> {
  let parent = dirname(absolutePath);
  while (true) {
    throwIfAborted(signal);
    try {
      const parentEntry = await throwIfAbortedAfter(lstat(parent), signal);
      if (parentEntry.isSymbolicLink()) {
        let targetStat;
        try {
          targetStat = await throwIfAbortedAfter(stat(parent), signal);
        } catch (error) {
          if (isNodeErrorWithCode(error, "ENOENT")) {
            throw new Error(`Parent path is a dangling symbolic link: ${parent}.`);
          }
          throw error;
        }
        if (!targetStat.isDirectory()) throw new Error(`Parent path is not a directory: ${parent}.`);
      } else if (!parentEntry.isDirectory()) {
        throw new Error(`Parent path is not a directory: ${parent}.`);
      }
      return;
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
      const next = dirname(parent);
      if (next === parent) return;
      parent = next;
    }
  }
}

async function assertDistinctMoveFiles(
  path: string,
  absolutePath: string,
  moveTo: string,
  absoluteMoveToPath: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const [sourceRealPath, destinationRealPath] = await Promise.all([
      throwIfAbortedAfter(realpath(absolutePath), signal),
      throwIfAbortedAfter(realpath(absoluteMoveToPath), signal),
    ]);
    if (mutationPathKey(sourceRealPath) === mutationPathKey(destinationRealPath)) {
      throw new Error(`${path}: Move destination ${moveTo} resolves to the source file.`);
    }
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT") && !isNodeErrorWithCode(error, "ENOTDIR")) throw error;
  }
}

async function preflightFile(
  file: ApplyPatchFile,
  absolutePath: string,
  absoluteMoveToPath: string | undefined,
  signal?: AbortSignal,
): Promise<MutationPlan> {
  if (file.operation === "add") {
    throwIfAborted(signal);
    try {
      await throwIfAbortedAfter(lstat(absolutePath), signal);
      throw new Error(`${file.path}: Add File requires a path that does not exist.`);
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT") && !isNodeErrorWithCode(error, "ENOTDIR")) throw error;
    }
    await assertAddParentIsDirectory(absolutePath, signal);
    const after = file.lines.length === 0 ? "" : `${file.lines.join("\n")}\n`;
    return {
      operation: "add",
      path: file.path,
      absolutePath,
      before: null,
      after,
      outputBytes: encodeTextFile(after, "utf-8", "none"),
    };
  }

  throwIfAborted(signal);
  let fileStat;
  try {
    fileStat = await throwIfAbortedAfter(
      file.operation === "update" && file.moveTo !== undefined ? lstat(absolutePath) : stat(absolutePath),
      signal,
    );
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) throw new Error(`${file.path}: file does not exist.`);
    throw error;
  }
  if (file.operation === "update" && file.moveTo !== undefined && fileStat.isSymbolicLink()) {
    throw new Error(`${file.path}: Move source must not be a symbolic link.`);
  }
  if (!fileStat.isFile()) throw new Error(`${file.path}: path is not a regular file.`);

  throwIfAborted(signal);
  const expectedBytes = await throwIfAbortedAfter(readFile(absolutePath), signal);
  const decoded = decodeTextFile(expectedBytes);
  if (decoded === null) throw new Error(`${file.path}: file appears to be binary.`);

  if (file.operation === "delete") {
    return {
      operation: "delete",
      path: file.path,
      absolutePath,
      before: decoded.text,
      after: null,
      expectedBytes,
    };
  }

  // Move-only updates have no hunks; content is preserved and written to the destination.
  const after = file.chunks.length === 0
    ? decoded.text
    : applyUpdate(file.path, decoded.text, file.chunks);
  const outputBytes = encodeTextFile(after, decoded.encoding, decoded.bom);

  if (file.moveTo !== undefined) {
    if (absoluteMoveToPath === undefined) {
      throw new Error(`${file.path}: Move destination path is missing.`);
    }
    if (mutationPathKey(absolutePath) === mutationPathKey(absoluteMoveToPath)) {
      throw new Error(`${file.path}: Move destination must differ from the source path.`);
    }
    await assertAddParentIsDirectory(absoluteMoveToPath, signal);
    let expectedMoveToBytes: Buffer | null = null;
    try {
      const destStat = await throwIfAbortedAfter(lstat(absoluteMoveToPath), signal);
      if (destStat.isSymbolicLink()) {
        throw new Error(`${file.moveTo}: Move destination must not be a symbolic link.`);
      }
      if (!destStat.isFile()) {
        throw new Error(`${file.moveTo}: Move destination exists and is not a regular file.`);
      }
      await assertDistinctMoveFiles(file.path, absolutePath, file.moveTo, absoluteMoveToPath, signal);
      expectedMoveToBytes = await throwIfAbortedAfter(readFile(absoluteMoveToPath), signal);
      // Codex overwrites an existing destination file when moving.
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT") && !isNodeErrorWithCode(error, "ENOTDIR")) throw error;
    }
    return {
      operation: "update",
      path: file.path,
      absolutePath,
      moveTo: file.moveTo,
      absoluteMoveToPath,
      expectedMoveToBytes,
      sourceMode: fileStat.mode & 0o7777,
      before: decoded.text,
      after,
      expectedBytes,
      outputBytes,
    };
  }

  return {
    operation: "update",
    path: file.path,
    absolutePath,
    before: decoded.text,
    after,
    expectedBytes,
    outputBytes,
  };
}

function rememberResolvedPath(
  seenAbsolutePaths: Map<string, string>,
  absolutePath: string,
  label: string,
): void {
  const key = mutationPathKey(absolutePath);
  const previous = seenAbsolutePaths.get(key);
  if (previous !== undefined) {
    throw new Error(`Duplicate resolved patch path: ${previous} and ${label}.`);
  }
  seenAbsolutePaths.set(key, label);
}

interface OutputPathRecord {
  absolutePath: string;
  label: string;
}

function rememberOutputPath(outputPaths: Map<string, OutputPathRecord>, absolutePath: string, label: string): void {
  outputPaths.set(mutationPathKey(absolutePath), { absolutePath, label });
}

async function resolveCanonicalMutationPath(absolutePath: string, signal?: AbortSignal): Promise<string> {
  let candidate = absolutePath;
  const missingSuffix: string[] = [];
  while (true) {
    try {
      const resolved = await throwIfAbortedAfter(realpath(candidate), signal);
      return missingSuffix.length === 0 ? resolved : join(resolved, ...missingSuffix);
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT") && !isNodeErrorWithCode(error, "ENOTDIR")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return absolutePath;
      missingSuffix.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

async function resolveMutationIdentity(absolutePath: string, signal?: AbortSignal): Promise<string> {
  try {
    const info = await throwIfAbortedAfter(stat(absolutePath, { bigint: true }), signal);
    if (info.ino > 0n) return `inode:${info.dev}:${info.ino}`;
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT") && !isNodeErrorWithCode(error, "ENOTDIR")) throw error;
  }
  const canonicalPath = await resolveCanonicalMutationPath(absolutePath, signal);
  return `path:${mutationPathKey(canonicalPath)}`;
}

async function assertNoFilesystemIdentityConflicts(plans: readonly MutationPlan[], signal?: AbortSignal): Promise<void> {
  const seenIdentities = new Map<string, string>();
  for (const plan of plans) {
    const paths = [
      { absolutePath: plan.absolutePath, label: plan.path },
      ...(plan.operation === "update" && plan.absoluteMoveToPath !== undefined && plan.moveTo !== undefined
        ? [{ absolutePath: plan.absoluteMoveToPath, label: plan.moveTo }]
        : []),
    ];
    for (const path of paths) {
      throwIfAborted(signal);
      const identity = await resolveMutationIdentity(path.absolutePath, signal);
      const previous = seenIdentities.get(identity);
      if (previous !== undefined) {
        throw new Error(`Patch paths ${previous} and ${path.label} resolve to the same filesystem entry.`);
      }
      seenIdentities.set(identity, path.label);
    }
  }
}

function assertNoHierarchicalOutputConflicts(outputPaths: ReadonlyMap<string, OutputPathRecord>): void {
  for (const [key, { label }] of outputPaths) {
    for (let index = 1; index < key.length; index++) {
      const isSeparator = key[index] === "/" || (process.platform === "win32" && key[index] === "\\");
      if (!isSeparator) continue;
      const ancestor = outputPaths.get(key.slice(0, index))?.label;
      if (ancestor !== undefined) {
        throw new Error(`Conflicting patch output paths: ${ancestor} cannot be an ancestor of ${label}.`);
      }
    }
  }
}

async function assertNoCanonicalOutputConflicts(
  outputPaths: ReadonlyMap<string, OutputPathRecord>,
  signal?: AbortSignal,
): Promise<void> {
  const canonicalOutputPaths = new Map<string, OutputPathRecord>();
  for (const { absolutePath, label } of outputPaths.values()) {
    throwIfAborted(signal);
    const canonicalPath = await resolveCanonicalMutationPath(absolutePath, signal);
    const key = mutationPathKey(canonicalPath);
    const previous = canonicalOutputPaths.get(key);
    if (previous !== undefined) {
      throw new Error(`Patch paths ${previous.label} and ${label} resolve to the same output path.`);
    }
    canonicalOutputPaths.set(key, { absolutePath: canonicalPath, label });
  }
  assertNoHierarchicalOutputConflicts(canonicalOutputPaths);
}

async function buildMutationPlans(
  patch: ParsedApplyPatch,
  options: ApplyPatchExecutionOptions,
): Promise<MutationPlan[]> {
  const { cwd } = resolveToolWorkdir(patch.workdir, options.cwd ?? process.cwd());
  const resolved = patch.files.map((file) => ({
    file,
    absolutePath: resolveToCwd(file.path, cwd),
    absoluteMoveToPath: file.operation === "update" && file.moveTo !== undefined
      ? resolveToCwd(file.moveTo, cwd)
      : undefined,
  }));
  const seenAbsolutePaths = new Map<string, string>();
  const outputPaths = new Map<string, OutputPathRecord>();
  for (const item of resolved) {
    rememberResolvedPath(seenAbsolutePaths, item.absolutePath, item.file.path);
    if (item.absoluteMoveToPath !== undefined && item.file.operation === "update" && item.file.moveTo !== undefined) {
      rememberResolvedPath(seenAbsolutePaths, item.absoluteMoveToPath, item.file.moveTo);
      rememberOutputPath(outputPaths, item.absoluteMoveToPath, item.file.moveTo);
    }
    if (item.file.operation === "add") rememberOutputPath(outputPaths, item.absolutePath, item.file.path);
  }
  assertNoHierarchicalOutputConflicts(outputPaths);

  const plans: MutationPlan[] = [];
  const errors: string[] = [];
  for (const item of resolved) {
    throwIfAborted(options.signal);
    try {
      plans.push(await preflightFile(item.file, item.absolutePath, item.absoluteMoveToPath, options.signal));
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length === 0) {
    try {
      await assertNoCanonicalOutputConflicts(outputPaths, options.signal);
      await assertNoFilesystemIdentityConflicts(plans, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) throw new Error(`Patch preflight failed:\n- ${errors.join("\n- ")}`);
  return plans;
}

async function resolveMutationQueuePath(absolutePath: string, signal?: AbortSignal): Promise<string> {
  return resolveCanonicalMutationPath(absolutePath, signal);
}

async function withMutationQueues<T>(
  absolutePaths: readonly string[],
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const canonicalPaths = await Promise.all(absolutePaths.map((path) => resolveMutationQueuePath(path, signal)));
  const uniquePaths = new Map<string, string>();
  for (const path of canonicalPaths) uniquePaths.set(mutationPathKey(path), path);
  const orderedPaths = [...uniquePaths.values()].sort((left, right) =>
    mutationPathKey(left).localeCompare(mutationPathKey(right))
  );
  const acquire = (index: number): Promise<T> => index >= orderedPaths.length
    ? fn()
    : withFileMutationQueue(orderedPaths[index]!, () => acquire(index + 1));
  return acquire(0);
}

async function assertMoveDestinationUnchanged(plan: UpdateMutationPlan, signal?: AbortSignal): Promise<void> {
  if (plan.absoluteMoveToPath === undefined || plan.moveTo === undefined || plan.expectedMoveToBytes === undefined) return;
  let currentBytes: Buffer | null;
  try {
    const currentStat = await throwIfAbortedAfter(lstat(plan.absoluteMoveToPath), signal);
    if (currentStat.isSymbolicLink()) {
      throw new Error(`${plan.moveTo}: Move destination must not be a symbolic link.`);
    }
    if (!currentStat.isFile()) {
      throw new Error(`${plan.moveTo}: Move destination changed after preflight: path is not a regular file.`);
    }
    currentBytes = await throwIfAbortedAfter(readFile(plan.absoluteMoveToPath), signal);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
    currentBytes = null;
  }
  if (plan.expectedMoveToBytes === null && currentBytes !== null) {
    throw new Error(`${plan.moveTo}: Move destination changed after preflight: path now exists.`);
  }
  if (plan.expectedMoveToBytes !== null && currentBytes === null) {
    throw new Error(`${plan.moveTo}: Move destination changed after preflight: file no longer exists.`);
  }
  if (plan.expectedMoveToBytes !== null && currentBytes !== null && !currentBytes.equals(plan.expectedMoveToBytes)) {
    throw new Error(`${plan.moveTo}: Move destination changed after preflight; refusing to overwrite stale contents.`);
  }
  if (currentBytes !== null) {
    await assertDistinctMoveFiles(plan.path, plan.absolutePath, plan.moveTo, plan.absoluteMoveToPath, signal);
  }
}

async function commitMutation(plan: MutationPlan, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const queuePaths = plan.operation === "update" && plan.absoluteMoveToPath !== undefined
    ? [plan.absolutePath, plan.absoluteMoveToPath]
    : [plan.absolutePath];

  await withMutationQueues(queuePaths, signal, async () => {
    const run = async () => {
      throwIfAborted(signal);
      if (plan.operation === "add") {
        await mkdir(dirname(plan.absolutePath), { recursive: true });
        throwIfAborted(signal);
        await writeFile(plan.absolutePath, plan.outputBytes, { flag: "wx", signal });
        return;
      }

      let currentBytes: Buffer;
      try {
        if (plan.operation === "update" && plan.absoluteMoveToPath !== undefined) {
          const currentStat = await throwIfAbortedAfter(lstat(plan.absolutePath), signal);
          if (currentStat.isSymbolicLink()) {
            throw new Error(`${plan.path}: Move source must not be a symbolic link.`);
          }
          if (!currentStat.isFile()) {
            throw new Error(`${plan.path} changed after preflight: path is not a regular file.`);
          }
          if (plan.sourceMode === undefined) throw new Error(`${plan.path}: Move source mode is missing.`);
          if ((currentStat.mode & 0o7777) !== plan.sourceMode) {
            throw new Error(`${plan.path} changed after preflight: permission bits changed; refusing to apply a stale Move.`);
          }
        }
        currentBytes = await throwIfAbortedAfter(readFile(plan.absolutePath), signal);
      } catch (error) {
        if (isNodeErrorWithCode(error, "ENOENT")) {
          throw new Error(`${plan.path} changed after preflight: file no longer exists.`);
        }
        throw error;
      }
      if (!currentBytes.equals(plan.expectedBytes)) {
        throw new Error(`${plan.path} changed after preflight; refusing to apply a stale patch.`);
      }

      throwIfAborted(signal);
      if (plan.operation === "delete") {
        await unlink(plan.absolutePath);
        return;
      }

      if (plan.absoluteMoveToPath !== undefined) {
        await assertMoveDestinationUnchanged(plan, signal);
        if (plan.sourceMode === undefined) throw new Error(`${plan.path}: Move source mode is missing.`);
        // Codex-style move: write destination (creating parents), then remove source.
        await mkdir(dirname(plan.absoluteMoveToPath), { recursive: true });
        throwIfAborted(signal);
        await writeFile(plan.absoluteMoveToPath, plan.outputBytes, { mode: plan.sourceMode, signal });
        await chmod(plan.absoluteMoveToPath, plan.sourceMode);
        throwIfAborted(signal);
        await unlink(plan.absolutePath);
        return;
      }

      await writeFile(plan.absolutePath, plan.outputBytes, { signal });
    };
    await run();
  });
}

function toFileResult(plan: MutationPlan): ApplyPatchFileResult {
  return {
    operation: plan.operation,
    path: plan.path,
    absolutePath: plan.absolutePath,
    ...(plan.operation === "update" && plan.moveTo !== undefined
      ? { moveTo: plan.moveTo, absoluteMoveToPath: plan.absoluteMoveToPath }
      : {}),
    before: plan.before,
    after: plan.after,
  };
}

export async function executeApplyPatch(
  patchOrText: ParsedApplyPatch | string,
  options: ApplyPatchExecutionOptions = {},
): Promise<ApplyPatchExecutionResult> {
  throwIfAborted(options.signal);
  const patch = typeof patchOrText === "string" ? parseApplyPatch(patchOrText) : patchOrText;
  const plans = await buildMutationPlans(patch, options);
  const results: ApplyPatchFileResult[] = [];
  for (const plan of plans) {
    try {
      await commitMutation(plan, options.signal);
    } catch (error) {
      const failure: ApplyPatchCommitFailure = {
        operation: plan.operation,
        path: plan.path,
        absolutePath: plan.absolutePath,
        ...(plan.operation === "update" && plan.moveTo !== undefined
          ? { moveTo: plan.moveTo, absoluteMoveToPath: plan.absoluteMoveToPath }
          : {}),
        state: "unknown",
      };
      const commitError = new ApplyPatchCommitError(failure, results, error);
      try {
        await options.onCommitFailed?.({ ...failure });
      } catch {
        // Preserve the filesystem failure; cache/observer cleanup is best-effort.
      }
      throw commitError;
    }
    const result = toFileResult(plan);
    results.push(result);
    try {
      await options.onCommitted?.({ ...result });
    } catch {
      // The filesystem mutation is already committed; observer failures are non-fatal.
    }
  }
  return { files: results };
}
