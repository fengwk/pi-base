import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  files: ApplyPatchFile[];
}

export interface ApplyPatchIntent {
  operation: ApplyPatchOperation;
  path: string;
  moveTo?: string;
}

export interface ApplyPatchExecutionOptions {
  workdir?: unknown;
  cwd?: string;
  signal?: AbortSignal;
  onCommitted?: (result: ApplyPatchFileResult) => void | Promise<void>;
  onCommitFailed?: (failure: ApplyPatchCommitFailure) => void | Promise<void>;
}

export interface ApplyPatchCommitFailure {
  operation: ApplyPatchOperation;
  path: string;
  absolutePath: string;
  state: "unknown";
}

export interface ApplyPatchFileResult {
  operation: ApplyPatchOperation;
  path: string;
  absolutePath: string;
  before: string | null;
  after: string | null;
}

export interface ApplyPatchExecutionResult {
  files: ApplyPatchFileResult[];
}

export class ApplyPatchCommitError extends Error {
  readonly failedPath: string;
  readonly failedPathState = "unknown" as const;
  readonly causeMessage: string;
  readonly appliedPaths: string[];
  readonly appliedFiles: ApplyPatchFileResult[];

  constructor(failedPath: string, appliedFiles: ApplyPatchFileResult[], cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    const appliedPaths = appliedFiles.map((file) => file.path);
    const applied = appliedPaths.length === 0
      ? "No patch files were applied."
      : `Already applied: ${appliedPaths.join(", ")}.`;
    super(`Failed to apply patch for ${failedPath}. ${applied} Cause: ${causeMessage}`, { cause });
    this.name = "ApplyPatchCommitError";
    this.failedPath = failedPath;
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

function normalizePatchText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function trimSurroundingBlankLines(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 1 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 1 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.join("\n");
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

function isFileDirective(line: string): boolean {
  return FILE_DIRECTIVE_PREFIXES.some((prefix) => line.startsWith(prefix));
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

  while (index < lines.length) {
    const line = lines[index]!;
    if (isPatchMarker(line, "*** End Patch")) {
      foundEnd = true;
      index++;
      break;
    }

    if (line.startsWith("*** Add File:")) {
      const path = parseRequiredPath(line, "*** Add File:");
      assertUniquePath(path, seenPaths);
      index++;
      const content: string[] = [];
      while (index < lines.length && !isPatchMarker(lines[index]!, "*** End Patch") && !isFileDirective(lines[index]!)) {
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

    if (line.startsWith("*** Delete File:")) {
      const path = parseRequiredPath(line, "*** Delete File:");
      assertUniquePath(path, seenPaths);
      index++;
      if (index < lines.length && !isPatchMarker(lines[index]!, "*** End Patch") && !isFileDirective(lines[index]!)) {
        throw new Error(`Delete File ${path} must not have a body.`);
      }
      files.push({ operation: "delete", path });
      continue;
    }

    if (line.startsWith("*** Update File:")) {
      const path = parseRequiredPath(line, "*** Update File:");
      assertUniquePath(path, seenPaths);
      index++;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to:")) {
        moveTo = parseRequiredPath(lines[index]!, "*** Move to:");
        assertUniquePath(moveTo, seenPaths);
        index++;
      }

      const chunks: ApplyPatchChunk[] = [];
      while (index < lines.length && !isPatchMarker(lines[index]!, "*** End Patch") && !isFileDirective(lines[index]!)) {
        const chunkHeader = lines[index]!;
        if (!chunkHeader.startsWith("@@")) {
          throw new Error(`Malformed Update File ${path}: expected an @@ chunk, got ${chunkHeader}.`);
        }
        const rawChangeContext = chunkHeader.slice(2).trim();
        const changeContext = rawChangeContext.length === 0 ? undefined : rawChangeContext;
        index++;

        const chunkLines: ApplyPatchChunkLine[] = [];
        let endOfFile = false;
        while (index < lines.length && !isPatchMarker(lines[index]!, "*** End Patch") && !isFileDirective(lines[index]!) && !lines[index]!.startsWith("@@")) {
          const bodyLine = lines[index]!;
          if (bodyLine === "*** End of File") {
            endOfFile = true;
            index++;
            if (index < lines.length && !isPatchMarker(lines[index]!, "*** End Patch") && !isFileDirective(lines[index]!)) {
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
      if (chunks.length === 0) throw new Error(`Update File ${path} must contain at least one @@ chunk.`);
      files.push({ operation: "update", path, ...(moveTo === undefined ? {} : { moveTo }), chunks });
      continue;
    }

    throw new Error(`Unknown patch line: ${line}.`);
  }

  if (!foundEnd) throw new Error("Patch must end with *** End Patch.");
  while (index < lines.length && lines[index] === "") index++;
  if (index !== lines.length) throw new Error(`Unknown patch line after *** End Patch: ${lines[index]}.`);
  if (files.length === 0) throw new Error("Patch must contain at least one file operation.");
  return { files };
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

function withoutTrailingEmptyCompatibilityLines(lines: readonly ApplyPatchChunkLine[]): ApplyPatchChunkLine[] {
  let oldIndex = -1;
  let newIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]!.kind !== "add") {
      oldIndex = index;
      break;
    }
  }
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]!.kind !== "delete") {
      newIndex = index;
      break;
    }
  }
  const removed = new Set<number>([oldIndex]);
  if (newIndex !== -1 && lines[newIndex]!.text === "") removed.add(newIndex);
  return lines.filter((_line, index) => !removed.has(index));
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
        const compatibilityLines = withoutTrailingEmptyCompatibilityLines(lines);
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
      const parentStat = await throwIfAbortedAfter(stat(parent), signal);
      if (!parentStat.isDirectory()) throw new Error(`Parent path is not a directory: ${parent}.`);
      return;
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
      const next = dirname(parent);
      if (next === parent) return;
      parent = next;
    }
  }
}

async function preflightFile(file: ApplyPatchFile, absolutePath: string, signal?: AbortSignal): Promise<MutationPlan> {
  if (file.operation === "add") {
    throwIfAborted(signal);
    try {
      await throwIfAbortedAfter(stat(absolutePath), signal);
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
    fileStat = await throwIfAbortedAfter(stat(absolutePath), signal);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) throw new Error(`${file.path}: file does not exist.`);
    throw error;
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

  const after = applyUpdate(file.path, decoded.text, file.chunks);
  const outputBytes = encodeTextFile(after, decoded.encoding, decoded.bom);
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

async function buildMutationPlans(
  patch: ParsedApplyPatch,
  options: ApplyPatchExecutionOptions,
): Promise<MutationPlan[]> {
  const { cwd } = resolveToolWorkdir(options.workdir, options.cwd ?? process.cwd());
  const resolved = patch.files.map((file) => ({ file, absolutePath: resolveToCwd(file.path, cwd) }));
  const seenAbsolutePaths = new Map<string, string>();
  for (const item of resolved) {
    const key = mutationPathKey(item.absolutePath);
    const previous = seenAbsolutePaths.get(key);
    if (previous !== undefined) {
      throw new Error(`Duplicate resolved patch path: ${previous} and ${item.file.path}.`);
    }
    seenAbsolutePaths.set(key, item.file.path);
  }

  const plans: MutationPlan[] = [];
  const errors: string[] = [];
  for (const item of resolved) {
    throwIfAborted(options.signal);
    try {
      plans.push(await preflightFile(item.file, item.absolutePath, options.signal));
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) throw new Error(`Patch preflight failed:\n- ${errors.join("\n- ")}`);
  return plans;
}

async function commitMutation(plan: MutationPlan, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await withFileMutationQueue(plan.absolutePath, async () => {
    throwIfAborted(signal);
    if (plan.operation === "add") {
      await mkdir(dirname(plan.absolutePath), { recursive: true });
      await writeFile(plan.absolutePath, plan.outputBytes, { flag: "wx" });
      return;
    }

    let currentBytes: Buffer;
    try {
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

    if (plan.operation === "delete") {
      await unlink(plan.absolutePath);
    } else {
      await writeFile(plan.absolutePath, plan.outputBytes);
    }
  });
}

export async function executeApplyPatch(
  patchOrText: ParsedApplyPatch | string,
  options: ApplyPatchExecutionOptions = {},
): Promise<ApplyPatchExecutionResult> {
  throwIfAborted(options.signal);
  const patch = typeof patchOrText === "string" ? parseApplyPatch(patchOrText) : patchOrText;
  const move = patch.files.find((file): file is ApplyPatchUpdateFile => file.operation === "update" && file.moveTo !== undefined);
  if (move?.moveTo !== undefined) throw new Error(`Move operations are not supported: ${move.path} -> ${move.moveTo}.`);

  const plans = await buildMutationPlans(patch, options);
  const results: ApplyPatchFileResult[] = [];
  for (const plan of plans) {
    try {
      await commitMutation(plan, options.signal);
    } catch (error) {
      try {
        await options.onCommitFailed?.({
          operation: plan.operation,
          path: plan.path,
          absolutePath: plan.absolutePath,
          state: "unknown",
        });
      } catch {
        // Preserve the filesystem failure; cache/observer cleanup is best-effort.
      }
      throw new ApplyPatchCommitError(plan.path, results, error);
    }
    const result: ApplyPatchFileResult = {
      operation: plan.operation,
      path: plan.path,
      absolutePath: plan.absolutePath,
      before: plan.before,
      after: plan.after,
    };
    results.push(result);
    try {
      await options.onCommitted?.({ ...result });
    } catch {
      // The filesystem mutation is already committed; observer failures are non-fatal.
    }
  }
  return { files: results };
}
