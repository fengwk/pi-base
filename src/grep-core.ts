import { spawn } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { ensureTool } from "./internal/pi-coding-agent-utils.js";
import { normalizeToLF } from "./line-endings.js";
import { describeToolWorkdirForDisplay, resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import { createGracefulTerminator } from "./process-termination.js";
import { formatOptionalArgs, shortenHomePath, styleAccent, styleMuted, styleOutput, styleToolTitle } from "./render.js";
import {
  BINARY_PROBE_BYTES,
  BinaryFileError,
  type DecodedTextFile,
  decodeTextFile,
  formatTextFileError,
  looksLikeBinary,
} from "./text-codec.js";
import { createTimeoutSignal, parsePositiveNumber, parseTimeoutSeconds } from "./timeout.js";

const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_SECONDS = 15;
/** Declaration-like text or invalid UTF-8: the only files that can decode differently from plain UTF-8. */
const DECODE_CANDIDATE_PATTERN = "coding[:=]|charset|<\\?xml|pageEncoding|\\x{FFFD}";
const NOT_SEARCHED_NOTICE_LIMIT = 10;
/** Decoded-text searches run as separate ripgrep processes, so keep the fan-out bounded. */
const DECODED_SEARCH_CONCURRENCY = 8;
// Displayed budget per line, counted in Unicode code points so surrogate
// pairs are never split when excerpts are cut.
const GREP_MAX_LINE_LENGTH = 500;
export type GrepFactory = (cwd: string) => { execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any> };

function explainRegexParseError(message: string, literal: boolean): string {
  if (literal || !/\bregex parse error\b/i.test(message)) return message;
  return `${message}\n\nThe pattern was parsed as a regular expression, but its syntax is invalid. Use literal=true for exact text, or escape regex metacharacters.`;
}

function formatGrepPattern(value: unknown): string {
  if (value === undefined || value === null) return "<missing-pattern>";
  return JSON.stringify(String(value));
}

export function formatGrepCall(args: any, theme: any, cwd?: string): string {
  const pattern = formatGrepPattern(args?.pattern);
  const searchPath = shortenHomePath(String(args?.path ?? "<missing-path>"));
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleMuted(theme, " from ")}${styleAccent(theme, shortenHomePath(rawWorkdir))}`;
  const suffix = formatOptionalArgs([
    ["include", args?.include],
    ["ignore_case", args?.ignore_case === true ? true : undefined],
    ["literal", args?.literal === true ? true : undefined],
    ["multiline", args?.multiline === true ? true : undefined],
    ["limit", args?.limit],
    ["timeout_seconds", args?.timeout_seconds],
  ]);
  return `${styleToolTitle(theme, "grep")} ${styleOutput(theme, pattern)} ${styleMuted(theme, "in")} ${styleAccent(theme, searchPath)}${workdir}${styleOutput(theme, suffix)}`;
}

/** The built-in grep implementation reads files itself, so only its binary verdict comes from the codec. */
async function hasBinaryPrefix(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const prefix = Buffer.allocUnsafe(BINARY_PROBE_BYTES);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    return looksLikeBinary(prefix.subarray(0, bytesRead));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface GrepSearchOptions {
  pattern: string;
  /** Path as the caller wrote it, for messages. */
  displayPath: string;
  absolutePath: string;
  searchPathIsDirectory: boolean;
  /** False when the single-file path does not exist yet: ripgrep reports that itself. */
  existingFile: boolean;
  include?: string;
  caseInsensitive?: boolean;
  literal?: boolean;
  multiline?: boolean;
  limit: number;
}

interface GrepMatch {
  /** Byte identity of the absolute path, so non-UTF-8 names still match a pre-pass entry. */
  fileKey: string;
  /** Absolute path bytes for reading the file back. */
  filePathBytes: Buffer;
  /** Absolute path for display, decoded as UTF-8. */
  absolutePath: string;
  lineNumber: number;
  lineText?: string;
  submatches?: RipgrepSubmatch[];
}

interface RipgrepSubmatch {
  // UTF-8 byte offsets relative to the start of the raw "lines" block.
  start: number;
  end: number;
}

// Ripgrep roots --glob at its own process cwd, and it never matches a leading "./"
// glob ("./src/*.ts" finds nothing). Strip leading "./" while keeping "!" negation.
function normalizeIncludeGlob(include: string): string {
  return include.replace(/^(!?)(?:\.\/)+/, "$1");
}

interface RipgrepMatchEvent {
  fileKey: string;
  filePathBytes: Buffer;
  absolutePath: string;
  lineNumber?: number;
  lineText?: string;
  submatches?: RipgrepSubmatch[];
}

/** A path keeps its bytes as identity; only its display copy is decoded as UTF-8. */
interface ResolvedGrepPath {
  fileKey: string;
  filePathBytes: Buffer;
  absolutePath: string;
}

function resolvedGrepPath(filePathBytes: Buffer): ResolvedGrepPath {
  return {
    fileKey: filePathBytes.toString("latin1"),
    filePathBytes,
    absolutePath: filePathBytes.toString("utf8"),
  };
}

function pathIsAbsoluteBytes(filePathBytes: Buffer): boolean {
  return filePathBytes[0] === 0x2f || (filePathBytes[1] === 0x3a && filePathBytes[0] !== undefined);
}

/** Directory searches print paths relative to the search root; absolute output passes through. */
function absolutePathBytes(filePathBytes: Buffer, options: GrepSearchOptions): Buffer {
  if (pathIsAbsoluteBytes(filePathBytes) || !options.searchPathIsDirectory) return filePathBytes;
  const relative = filePathBytes.subarray(0, 2).toString("latin1") === "./" ? filePathBytes.subarray(2) : filePathBytes;
  return Buffer.concat([Buffer.from(`${options.absolutePath}${path.sep}`, "utf8"), relative]);
}

function parseRipgrepSubmatches(value: unknown): RipgrepSubmatch[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const submatches: RipgrepSubmatch[] = [];
  for (const item of value) {
    const start = (item as { start?: unknown } | null)?.start;
    const end = (item as { end?: unknown } | null)?.end;
    if (typeof start === "number" && typeof end === "number" && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start) {
      submatches.push({ start, end });
    }
  }
  return submatches.length > 0 ? submatches : undefined;
}

function parseRipgrepMatchEvent(line: string, options: GrepSearchOptions): RipgrepMatchEvent | null {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event.type !== "match") return null;
  const rawPath = event.data?.path as { text?: unknown; bytes?: unknown } | undefined;
  let filePathBytes: Buffer | undefined;
  if (typeof rawPath?.bytes === "string") {
    filePathBytes = absolutePathBytes(Buffer.from(rawPath.bytes, "base64"), options);
  } else if (typeof rawPath?.text === "string") {
    const base = options.searchPathIsDirectory ? options.absolutePath : process.cwd();
    filePathBytes = Buffer.from(path.resolve(base, rawPath.text), "utf8");
  }
  if (!filePathBytes) return null;
  return {
    ...resolvedGrepPath(filePathBytes),
    lineNumber: typeof event.data?.line_number === "number" ? event.data.line_number : undefined,
    lineText: typeof event.data?.lines?.text === "string" ? event.data.lines.text : undefined,
    submatches: parseRipgrepSubmatches(event.data?.submatches),
  };
}

/**
 * One ripgrep scan lists the only files whose decoded text can differ from what
 * the main search matched: files with declaration-like text, and files that are
 * not valid UTF-8 (decoded lossily, so invalid bytes show up as U+FFFD).
 */
function scanDecodeCandidates(rgPath: string, options: GrepSearchOptions, signal?: AbortSignal): { candidates: Promise<Map<string, Buffer>>; stop: () => void } {
  const args = ["--no-config", "--files-with-matches", "--encoding", "utf-8", "--hidden", "--null"];
  if (options.include) args.push("--glob", normalizeIncludeGlob(options.include));
  args.push("--", DECODE_CANDIDATE_PATTERN, ".");
  const child = spawn(rgPath, args, {
    cwd: options.absolutePath,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const stop = () => {
    signal?.removeEventListener("abort", stop);
    child.kill();
  };
  signal?.addEventListener("abort", stop, { once: true });
  const candidates = new Promise<Map<string, Buffer>>((resolve) => {
    const finish = () => {
      signal?.removeEventListener("abort", stop);
      const paths = new Map<string, Buffer>();
      for (const entry of Buffer.concat(chunks).toString("latin1").split("\0")) {
        if (!entry) continue;
        const filePathBytes = absolutePathBytes(Buffer.from(entry, "latin1"), options);
        paths.set(filePathBytes.toString("latin1"), filePathBytes);
      }
      resolve(paths);
    };
    // A pre-pass failure only costs the encoding notice, so it never fails the search.
    child.on("error", finish);
    child.on("close", finish);
  });
  return { candidates, stop };
}

interface DecodedCandidates {
  /** Files that must be searched on their decoded text instead of ripgrep's raw matches. */
  replacements: Map<string, GrepMatch[]>;
  /** Rejected files by key, with the absolute path shown in the notice. */
  skipped: Map<string, string>;
}

async function decodeCandidates(
  rgPath: string,
  paths: Map<string, Buffer>,
  options: GrepSearchOptions,
  signal?: AbortSignal,
): Promise<DecodedCandidates> {
  const replacements = new Map<string, GrepMatch[]>();
  const skipped = new Map<string, string>();
  const entries = [...paths.entries()];
  const decodeOne = async ([fileKey, filePathBytes]: [string, Buffer]): Promise<void> => {
    let decoded: DecodedTextFile;
    try {
      decoded = decodeTextFile(await readFile(filePathBytes), filePathBytes.toString("utf8"));
    } catch (error) {
      // Binary files are not text at all; other rejections mean the encoding is undetermined.
      if (!(error instanceof BinaryFileError)) skipped.set(fileKey, filePathBytes.toString("utf8"));
      return;
    }
    if (decoded.encoding.name === "UTF-8") return;
    const resolved = resolvedGrepPath(filePathBytes);
    replacements.set(fileKey, await searchDecodedText(rgPath, decoded.text, resolved, options, signal));
  };
  for (let offset = 0; offset < entries.length; offset += DECODED_SEARCH_CONCURRENCY) {
    await Promise.all(entries.slice(offset, offset + DECODED_SEARCH_CONCURRENCY).map((entry) => decodeOne(entry)));
  }
  return { replacements, skipped };
}

/** Runs the same ripgrep engine over decoded UTF-8 text so line numbers match read. */
async function searchDecodedText(
  rgPath: string,
  text: string,
  resolved: ResolvedGrepPath,
  options: GrepSearchOptions,
  signal?: AbortSignal,
): Promise<GrepMatch[]> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const args = ["--no-config", "--json", "--line-number", "--color=never"];
  if (options.multiline) args.push("--multiline");
  if (options.caseInsensitive) args.push("--ignore-case");
  if (options.literal) args.push("--fixed-strings");
  args.push("--max-count", String(options.limit + 1), "--", options.pattern);
  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const terminator = createGracefulTerminator(child);
    const rl = createInterface({ input: child.stdout });
    const matches: GrepMatch[] = [];
    let stderr = "";
    let settled = false;
    const cleanup = () => {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
      terminator.cleanup();
    };
    const onAbort = () => terminator.terminate();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    rl.on("line", (line) => {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "match" || typeof event.data?.line_number !== "number") return;
      matches.push({
        ...resolved,
        lineNumber: event.data.line_number,
        lineText: typeof event.data?.lines?.text === "string" ? event.data.lines.text : undefined,
        submatches: parseRipgrepSubmatches(event.data?.submatches),
      });
    });
    child.on("error", (error) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to run ripgrep: ${error.message}`));
      }
    });
    child.on("close", (code) => {
      cleanup();
      if (settled) return;
      settled = true;
      if (signal?.aborted) {
        reject(new Error("Operation aborted"));
        return;
      }
      if (code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
        return;
      }
      resolve(matches);
    });
    // Normalized text keeps line numbers equal to read's, which splits on every line ending.
    child.stdin.end(normalizeToLF(text));
  });
}


interface FileSearchResult {
  matches: GrepMatch[];
  limitReached: boolean;
}

/** Runs ripgrep over the search path and returns matches in discovery order. */
async function searchFiles(rgPath: string, options: GrepSearchOptions, signal?: AbortSignal): Promise<FileSearchResult> {
  return new Promise((resolve, reject) => {
    const args = ["--no-config", "--json", "--line-number", "--color=never", "--hidden"];
    if (options.multiline) args.push("--multiline");
    if (options.caseInsensitive) args.push("--ignore-case");
    if (options.literal) args.push("--fixed-strings");
    // rg roots --glob at its own cwd, so a directory search runs inside searchPath.
    // It searches "." because rg canonicalizes its cwd: with an absolute path, a symlinked
    // searchPath (macOS /tmp) would no longer lie under the glob root.
    if (options.include) args.push("--glob", normalizeIncludeGlob(options.include));
    args.push("--", options.pattern, options.searchPathIsDirectory ? "." : options.absolutePath);

    const child = spawn(rgPath, args, {
      cwd: options.searchPathIsDirectory ? options.absolutePath : undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminator = createGracefulTerminator(child);
    const rl = createInterface({ input: child.stdout });
    let stderr = "";
    let matchLimitReached = false;
    let killedDueToLimit = false;
    let settled = false;
    const matches: GrepMatch[] = [];

    const cleanup = () => {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
      terminator.cleanup();
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const stopChild = (dueToLimit = false) => {
      killedDueToLimit = dueToLimit;
      terminator.terminate();
    };
    const onAbort = () => stopChild();

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    // Reaching the limit alone does not prove truncation: only a further match event
    // after N stored matches does. That lookahead match stops the search but is never
    // rendered, so exact-limit results carry no misleading truncation warning.
    rl.on("line", (line) => {
      if (!line.trim() || matchLimitReached) return;
      const match = parseRipgrepMatchEvent(line, options);
      if (!match || match.lineNumber === undefined) return;
      if (matches.length >= options.limit) {
        matchLimitReached = true;
        stopChild(true);
        return;
      }
      matches.push({ ...match, lineNumber: match.lineNumber });
    });
    child.on("error", (error) => {
      cleanup();
      settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
    });
    child.on("close", (code) => {
      cleanup();
      if (settled) return;
      if (signal?.aborted) {
        settle(() => reject(new Error("Operation aborted")));
        return;
      }
      if (!killedDueToLimit && code !== 0 && code !== 1) {
        const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
        settle(() => reject(new Error(errorMsg)));
        return;
      }
      settle(() => resolve({ matches, limitReached: matchLimitReached }));
    });
  });
}


// Prefix-truncate to GREP_MAX_LINE_LENGTH code points without splitting a
// surrogate pair; applied when no submatch position is available.
function truncateGrepLine(text: string): { text: string; wasTruncated: boolean } {
  const { unit } = walkForwardCodePoints(text, 0, GREP_MAX_LINE_LENGTH);
  if (unit >= text.length) return { text, wasTruncated: false };
  return { text: `${text.slice(0, unit)}…`, wasTruncated: true };
}

// Walk up to maxCodePoints code points forward from a code-point boundary,
// stopping at `to`. Counting on the fly avoids line-sized code-point arrays.
function walkForwardCodePoints(text: string, from: number, maxCodePoints: number, to = text.length): { unit: number; count: number } {
  let unit = from;
  let count = 0;
  while (unit < to && count < maxCodePoints) {
    const codePoint = text.codePointAt(unit)!;
    unit += codePoint >= 0x10000 ? 2 : 1;
    count += 1;
  }
  return { unit, count };
}

// Walk backward over up to maxCodePoints code points from a code-point
// boundary. A low surrogate preceded by a high surrogate is one code point,
// so the walk steps over both halves at once.
function walkBackwardCodePoints(text: string, from: number, maxCodePoints: number): { unit: number; count: number } {
  let unit = from;
  let count = 0;
  while (unit > 0 && count < maxCodePoints) {
    const low = text.charCodeAt(unit - 1);
    const high = unit >= 2 ? text.charCodeAt(unit - 2) : -1;
    unit -= low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? 2 : 1;
    count += 1;
  }
  return { unit, count };
}

// Convert a UTF-8 byte offset inside `text` into a UTF-16 unit index. rg
// reports submatch offsets on code-point boundaries; on any inconsistency the
// walk stops early instead of landing mid-code-point.
function unitAtByteOffset(text: string, byteOffset: number): number {
  let bytes = 0;
  let units = 0;
  while (units < text.length && bytes < byteOffset) {
    const codePoint = text.codePointAt(units)!;
    const width = codePoint >= 0x10000 ? 4 : codePoint >= 0x800 ? 3 : codePoint >= 0x80 ? 2 : 1;
    if (bytes + width > byteOffset) break;
    bytes += width;
    units += codePoint >= 0x10000 ? 2 : 1;
  }
  return units;
}

interface RawBlockLine {
  text: string;
  startByte: number;
  endByte: number;
}

// Split a raw ripgrep "lines" block into per-line records that keep each line's
// UTF-8 byte range within the block, so submatch byte offsets can be matched
// per line. Carriage returns stay in the text here because rg offsets include
// them; they are stripped from the rendered excerpt later.
function splitRawBlockLines(block: string): RawBlockLine[] {
  const rawLines = block.split("\n");
  // A trailing LF only terminates the last line; it does not start a new one.
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const lines: RawBlockLine[] = [];
  let startByte = 0;
  for (const text of rawLines) {
    const endByte = startByte + Buffer.byteLength(text, "utf8");
    lines.push({ text, startByte, endByte });
    startByte = endByte + 1; // + 1 for the LF that ended this line
  }
  return lines;
}

// Build a bounded excerpt around [matchStart, matchEnd) (UTF-16 indices on
// code-point boundaries). The excerpt content holds at most
// GREP_MAX_LINE_LENGTH code points, centered on the match when it fits; a
// match longer than the budget renders its leading part, which keeps the
// excerpt inside the matched region. Cut-off content is marked with "…".
function buildMatchExcerpt(text: string, matchStart: number, matchEnd: number): { text: string; wasTruncated: boolean } {
  // Probes are capped at budget + 1: a saturated probe proves the line exceeds
  // the budget, while unsaturated probes keep the fit check exact.
  const probeCap = GREP_MAX_LINE_LENGTH + 1;
  const matchCount = walkForwardCodePoints(text, matchStart, probeCap, matchEnd).count;
  const before = walkBackwardCodePoints(text, matchStart, probeCap);
  const after = walkForwardCodePoints(text, matchEnd, probeCap);
  if (before.count + matchCount + after.count <= GREP_MAX_LINE_LENGTH) {
    return { text, wasTruncated: false };
  }
  let startUnit: number;
  let endUnit: number;
  if (matchCount >= GREP_MAX_LINE_LENGTH) {
    startUnit = matchStart;
    endUnit = walkForwardCodePoints(text, matchStart, GREP_MAX_LINE_LENGTH).unit;
  } else {
    let beforeTake = Math.floor((GREP_MAX_LINE_LENGTH - matchCount) / 2);
    let afterTake = GREP_MAX_LINE_LENGTH - matchCount - beforeTake;
    if (beforeTake > before.count) {
      afterTake += beforeTake - before.count;
      beforeTake = before.count;
    }
    if (afterTake > after.count) {
      beforeTake = Math.min(beforeTake + afterTake - after.count, before.count);
      afterTake = after.count;
    }
    startUnit = walkBackwardCodePoints(text, matchStart, beforeTake).unit;
    endUnit = walkForwardCodePoints(text, matchEnd, afterTake).unit;
  }
  let excerpt = text.slice(startUnit, endUnit);
  if (startUnit > 0) excerpt = `…${excerpt}`;
  if (endUnit < text.length) excerpt = `${excerpt}…`;
  return { text: excerpt, wasTruncated: true };
}

// A zero-width match is a point, not a range: it belongs to a line when that
// point lies on the line, including its start and end (e.g. "^" and "$").
function submatchIntersectsLine(submatch: RipgrepSubmatch, line: RawBlockLine): boolean {
  if (submatch.start === submatch.end) {
    return submatch.start >= line.startByte && submatch.start <= line.endByte;
  }
  return submatch.end > line.startByte && submatch.start < line.endByte;
}

// Render each raw line of a ripgrep "lines" block. When rg reports submatch
// byte offsets, each line shows a bounded excerpt around the first matching
// range on that line, so far-tail matches stay visible; without offsets the
// line-start prefix fallback applies.
function formatMatchBlockLines(block: string, submatches: RipgrepSubmatch[] | undefined): { texts: string[]; linesTruncated: boolean } {
  let linesTruncated = false;
  const texts = splitRawBlockLines(block).map((rawLine) => {
    const hit = submatches?.find((submatch) => submatchIntersectsLine(submatch, rawLine));
    let excerpt: { text: string; wasTruncated: boolean };
    if (hit) {
      const from = Math.max(hit.start, rawLine.startByte) - rawLine.startByte;
      const to = Math.min(hit.end, rawLine.endByte) - rawLine.startByte;
      excerpt = buildMatchExcerpt(rawLine.text, unitAtByteOffset(rawLine.text, from), unitAtByteOffset(rawLine.text, to));
    } else {
      excerpt = truncateGrepLine(rawLine.text);
    }
    if (excerpt.wasTruncated) linesTruncated = true;
    // Carriage returns are stripped only after excerpting so byte offsets stay
    // aligned with the raw rg block.
    return excerpt.text.replace(/\r/g, "");
  });
  return { texts, linesTruncated };
}

function formatGrepMatchPath(filePath: string, absolutePath: string, searchPathIsDirectory: boolean): string {
  if (searchPathIsDirectory) {
    const relative = path.relative(absolutePath, filePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.replace(/\\/g, "/");
  }
  return path.basename(filePath);
}

/** The not-searched notice lists a bounded number of absolute paths, then a count. */
function formatNotSearchedPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, NOT_SEARCHED_NOTICE_LIMIT);
  const remaining = paths.length - shown.length;
  return [...shown, ...(remaining > 0 ? [`and ${remaining} more`] : [])].join(", ");
}

/** Replaces raw-byte results with decoded-text results, and drops files the codec rejects. */
function mergeDecodedMatches(matches: readonly GrepMatch[], decoded: DecodedCandidates): GrepMatch[] {
  const byFile = new Map<string, GrepMatch[]>();
  const fileOrder: string[] = [];
  for (const match of matches) {
    const existing = byFile.get(match.fileKey);
    if (existing) {
      existing.push(match);
    } else {
      byFile.set(match.fileKey, [match]);
      fileOrder.push(match.fileKey);
    }
  }
  const merged: GrepMatch[] = [];
  for (const fileKey of fileOrder) {
    const decodedMatches = decoded.replacements.get(fileKey);
    if (decodedMatches) merged.push(...decodedMatches);
    else if (!decoded.skipped.has(fileKey)) merged.push(...byFile.get(fileKey)!);
  }
  // A declared file matches only after decoding, so it has no raw-search position.
  for (const fileKey of [...decoded.replacements.keys()].filter((key) => !byFile.has(key)).sort()) {
    merged.push(...decoded.replacements.get(fileKey)!);
  }
  return merged;
}

async function formatGrepResult(
  options: GrepSearchOptions,
  matches: readonly GrepMatch[],
  limitReached: boolean,
  skippedPaths: readonly string[],
): Promise<any> {
  const outputLines: string[] = [];
  const fileCache = new Map<string, Promise<string[]>>();
  let linesTruncated = false;
  const displayPathOf = (match: GrepMatch) => formatGrepMatchPath(match.absolutePath, options.absolutePath, options.searchPathIsDirectory);
  const readFileLines = async (match: GrepMatch) => {
    let linesPromise = fileCache.get(match.fileKey);
    if (!linesPromise) {
      linesPromise = readFile(match.filePathBytes)
        .then((buffer) => decodeTextFile(buffer, match.absolutePath).text)
        .then((content) => content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n"))
        .catch(() => [] as string[]);
      fileCache.set(match.fileKey, linesPromise);
    }
    return linesPromise;
  };

  for (const match of matches) {
    const displayPath = displayPathOf(match);
    if (match.lineText !== undefined) {
      const formatted = formatMatchBlockLines(match.lineText, match.submatches);
      if (formatted.linesTruncated) linesTruncated = true;
      formatted.texts.forEach((text, index) => {
        outputLines.push(`${displayPath}:${match.lineNumber + index}: ${text}`);
      });
      continue;
    }
    // Multiline matches need rg's block text; only standard matches fall back to disk.
    if (options.multiline) continue;
    const lines = await readFileLines(match);
    if (!lines.length) {
      outputLines.push(`${displayPath}:${match.lineNumber}: (unable to read file)`);
      continue;
    }
    const { text, wasTruncated } = truncateGrepLine((lines[match.lineNumber - 1] ?? "").replace(/\r/g, ""));
    if (wasTruncated) linesTruncated = true;
    outputLines.push(`${displayPath}:${match.lineNumber}: ${text}`);
  }

  let output = outputLines.length > 0 ? outputLines.join("\n") : "No matches found";
  const details: Record<string, unknown> = {};
  const notices: string[] = [];
  if (limitReached) {
    notices.push(`${options.limit} matches limit reached. Use limit=${options.limit * 2} for more, or refine pattern`);
    details.matchLimitReached = options.limit;
  }
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
    details.linesTruncated = true;
  }
  if (skippedPaths.length > 0) {
    notices.push(`Not searched because the text encoding could not be determined: ${formatNotSearchedPaths(skippedPaths)}`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text" as const, text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

/** A single file is searched exactly on the text read shows when its encoding is not UTF-8. */
async function executeSingleFileSearch(rgPath: string, options: GrepSearchOptions, signal?: AbortSignal): Promise<any> {
  if (options.existingFile) {
    let decoded: DecodedTextFile;
    try {
      decoded = decodeTextFile(await readFile(options.absolutePath), options.absolutePath);
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${formatTextFileError(error, options.displayPath, "searched")} grep only supports searching text files or directories.` }],
        isError: true,
      };
    }
    if (decoded.encoding.name !== "UTF-8") {
      const resolved = resolvedGrepPath(Buffer.from(options.absolutePath, "utf8"));
      const matches = await searchDecodedText(rgPath, decoded.text, resolved, options, signal);
      return formatGrepResult(options, matches.slice(0, options.limit), matches.length > options.limit, []);
    }
  }
  const result = await searchFiles(rgPath, options, signal);
  return formatGrepResult(options, result.matches, result.limitReached, []);
}

async function executeGrepSearch(rgPath: string, options: GrepSearchOptions, signal?: AbortSignal): Promise<any> {
  if (!options.searchPathIsDirectory) return executeSingleFileSearch(rgPath, options, signal);

  const scan = scanDecodeCandidates(rgPath, options, signal);
  let result: FileSearchResult;
  let candidates: Map<string, Buffer>;
  try {
    result = await searchFiles(rgPath, options, signal);
    candidates = await scan.candidates;
  } finally {
    scan.stop();
  }
  const decoded = await decodeCandidates(rgPath, candidates, options, signal);
  const matches = mergeDecodedMatches(result.matches, decoded);
  const limitReached = result.limitReached || matches.length > options.limit;
  return formatGrepResult(options, matches.slice(0, options.limit), limitReached, [...decoded.skipped.values()].sort());
}

export async function executeGrep(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx: any = {}, createBuiltInGrepTool?: GrepFactory): Promise<any> {
  try {
    const pattern = String(params.pattern ?? "");
    const rawPath = String(params.path ?? "").replace(/^@/, "");
    if (!pattern) throw new Error("pattern is required.");
    if (!rawPath) throw new Error("path is required.");
    const { cwd } = resolveToolWorkdir(params.workdir, ctx.cwd ?? process.cwd());
    const absolutePath = resolveToCwd(rawPath, cwd);
    const timeoutSeconds = parseTimeoutSeconds(params.timeout_seconds, "timeout_seconds", DEFAULT_TIMEOUT_SECONDS);
    const limit = parsePositiveNumber(params.limit, "limit", DEFAULT_LIMIT);
    const multiline = params.multiline === true;

    const timeout = createTimeoutSignal(signal, timeoutSeconds);
    try {
      let searchPathIsDirectory = false;
      let existingFile = false;
      try {
        const searchPathStat = await stat(absolutePath);
        searchPathIsDirectory = searchPathStat.isDirectory();
        existingFile = searchPathStat.isFile();
        if (!searchPathIsDirectory && !existingFile) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rawPath} is not a regular file or directory. grep only supports searching text files or directories.` }],
            isError: true,
          };
        }
      } catch {
        searchPathIsDirectory = false;
      }

      if (!createBuiltInGrepTool) {
        // Never start a search after the deadline has passed.
        if (timeout.signal.aborted) throw new Error("Operation aborted");
        const rgPath = await ensureTool("rg", true, timeout.signal);
        if (!rgPath) throw new Error("ripgrep (rg) is not available and could not be downloaded");
        if (timeout.signal.aborted) throw new Error("Operation aborted");
        return await executeGrepSearch(rgPath, {
          pattern,
          displayPath: rawPath,
          absolutePath,
          searchPathIsDirectory,
          existingFile,
          include: params.include,
          caseInsensitive: params.ignore_case === true,
          literal: params.literal === true,
          multiline,
          limit,
        }, timeout.signal);
      }

      if (existingFile && await hasBinaryPrefix(absolutePath)) {
        return {
          content: [{ type: "text" as const, text: `Error: ${formatTextFileError(new BinaryFileError(), rawPath, "searched")} grep only supports searching text files or directories.` }],
          isError: true,
        };
      }

      const builtIn = createBuiltInGrepTool(cwd);
      return await builtIn.execute(toolCallId || toolCallIdPlaceholder, {
        path: absolutePath,
        pattern,
        glob: params.include,
        ignoreCase: params.ignore_case === true,
        literal: params.literal === true,
        timeout: timeoutSeconds,
        limit,
        ...(params.multiline === true ? { multiline: true } : {}),
      } as any, timeout.signal, onUpdate, ctx);
    } catch (error) {
      if (timeout.didTimeout()) {
        return { content: [{ type: "text" as const, text: `Error: Search timed out after ${timeoutSeconds}s.` }], isError: true };
      }
      throw error;
    } finally {
      timeout.cleanup();
    }
  } catch (error) {
    const message = explainRegexParseError((error as Error).message, params?.literal === true);
    return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
  }
}

const toolCallIdPlaceholder = "grep";
