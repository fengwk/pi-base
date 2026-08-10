import { type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TRUNCATION_DIR_PREFIX = "pi-base-truncation-";
const PROCESS_TRUNCATION_DIR_PREFIX = `${TRUNCATION_DIR_PREFIX}${process.pid}-`;
const MAX_HINT_OUTPUT_PATH_BYTES = 4 * 1024;

const BASH_TRUNCATION_HINT_REGEX = /\[Showing lines \d+-\d+ of \d+\. Full output: .*?\]/i;
let truncationDirState: { baseDir: string; promise: Promise<string> } | undefined;

function sanitizeToolNameForFilename(toolName: string): string {
  const sanitized = toolName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "tool";
}

function truncationDirOwnerPid(name: string): number | undefined {
  const match = name.match(/^pi-base-truncation-(\d+)-/);
  if (!match?.[1]) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function cleanupOldTruncationDirs(baseDir: string): Promise<void> {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const uid = process.getuid();
  const now = Date.now();
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return;
    const ownerPid = truncationDirOwnerPid(entry.name);
    if (ownerPid === undefined) return;
    const candidate = join(baseDir, entry.name);
    try {
      const info = await lstat(candidate);
      if (!info.isDirectory() || info.uid !== uid || now - info.mtimeMs <= RETENTION_MS) return;
      if (isProcessAlive(ownerPid)) return;
      await rm(candidate, { recursive: true, force: true });
    } catch {
      // Old-output cleanup is best-effort and never weakens creation permissions.
    }
  }));
}

async function createTruncationDir(baseDir: string): Promise<string> {
  await cleanupOldTruncationDirs(baseDir);
  const dir = await mkdtemp(join(baseDir, PROCESS_TRUNCATION_DIR_PREFIX));
  if (process.platform === "win32") return dir;
  try {
    await chmod(dir, 0o700);
    return dir;
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function getTruncationDir(): Promise<string> {
  const baseDir = tmpdir();
  if (truncationDirState?.baseDir !== baseDir) {
    const promise = createTruncationDir(baseDir);
    truncationDirState = { baseDir, promise };
    void promise.catch(() => {
      if (truncationDirState?.promise === promise) truncationDirState = undefined;
    });
  }
  return truncationDirState.promise;
}

async function writeFullOutput(text: string, toolName: string): Promise<string> {
  const safeToolName = sanitizeToolNameForFilename(toolName);
  for (let attempt = 0; attempt < 2; attempt++) {
    const dirPromise = getTruncationDir();
    const dir = await dirPromise;
    const filePath = join(dir, `${safeToolName}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.txt`);
    try {
      await writeFile(filePath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return filePath;
    } catch (error) {
      await rm(filePath, { force: true }).catch(() => undefined);
      if (attempt === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") {
        if (truncationDirState?.promise === dirPromise) truncationDirState = undefined;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Failed to create private full-output storage.");
}

function formatOutputPathForHint(outputPath: string): string {
  return Buffer.byteLength(outputPath, "utf8") <= MAX_HINT_OUTPUT_PATH_BYTES && !/[\r\n]/.test(outputPath)
    ? outputPath
    : "(path omitted; see details.truncation.outputPath)";
}

function buildTruncationHint(totalBytes: number, totalLines: number, outputPath: string | undefined): string {
  return outputPath
    ? `The tool call succeeded but the output was truncated. Full output (${totalBytes} bytes, ${totalLines} lines) saved to: ${formatOutputPathForHint(outputPath)}\nUse grep to search the full content or read with offset/limit to inspect specific sections.`
    : `The tool call succeeded but the output was truncated. Full output could not be saved to temporary storage (${totalBytes} bytes, ${totalLines} lines).\nRe-run the tool with a narrower scope if you need the omitted content.`;
}

function buildUpstreamRetruncationHint(outputPath: string | undefined): string {
  return outputPath
    ? `The upstream tool had already truncated this output, and the remaining preview exceeded pi-base's final output limit. Full upstream output: ${formatOutputPathForHint(outputPath)}\nUse grep to search the full content or read with offset/limit to inspect specific sections.`
    : "The upstream tool had already truncated this output, and the remaining preview exceeded pi-base's final output limit.\nRe-run the tool with a narrower scope if you need the omitted content.";
}

function buildTruncationFooter(removed: number, unit: "bytes" | "lines", hint: string): string {
  return `...${removed} ${unit} truncated...\n\n${hint}`;
}

function countLines(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 10) {
      lines++;
      continue;
    }
    if (code === 13) {
      lines++;
      if (text.charCodeAt(index + 1) === 10) index++;
    }
  }
  return lines;
}

interface TruncationResult {
  truncated: boolean;
  outputPath?: string;
  totalLines: number;
  totalBytes: number;
  /**
   * True when our handler observed the output was already truncated by an
   * earlier layer (for example Pi's built-in bash output or read/grep line
   * formatting). In that case we do not have the full text, so we do not
   * write to a `pi-base-truncation-*` directory. If the earlier layer exposed its own
   * full-output path, we preserve it in
   * `details.truncation.outputPath`.
   */
  alreadyTruncated: boolean;
}

function extractUpstreamOutputPath(text: string): string | undefined {
  const fullOutputMatch = text.match(/Full output:\s*(\S+?)(?:\]|$)/i);
  if (fullOutputMatch?.[1]) return fullOutputMatch[1];
  const savedToMatch = text.match(/saved to:\s*(\S+)/i);
  if (savedToMatch?.[1]) return savedToMatch[1];
  return undefined;
}

function extractDetailsOutputPath(details: any): string | undefined {
  const candidates = [details?.truncation?.outputPath, details?.fullOutputPath];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0);
}

async function truncateTextOutput(
  text: string,
  toolName: string,
  alreadyTruncatedByUpstream = false,
  upstreamOutputPath?: string,
): Promise<TruncationResult> {
  const totalLines = countLines(text);
  const totalBytes = Buffer.byteLength(text, "utf8");
  alreadyTruncatedByUpstream = alreadyTruncatedByUpstream || (toolName === "bash" && BASH_TRUNCATION_HINT_REGEX.test(text));
  if (alreadyTruncatedByUpstream) {
    return {
      truncated: true,
      outputPath: upstreamOutputPath ?? extractUpstreamOutputPath(text),
      totalLines,
      totalBytes,
      alreadyTruncated: true,
    };
  }
  if (totalLines <= MAX_LINES && totalBytes <= MAX_BYTES) {
    return { truncated: false, totalLines, totalBytes, alreadyTruncated: false };
  }

  let outputPath: string | undefined;
  try {
    outputPath = await writeFullOutput(text, toolName);
  } catch {
    // Keep the bounded preview even when auxiliary full-output storage is unavailable.
  }
  return {
    truncated: true,
    outputPath,
    totalLines,
    totalBytes,
    alreadyTruncated: false,
  };
}

interface TruncationMetadata {
  outputPath?: string;
  totalLines: number;
  totalBytes: number;
  alreadyTruncated: boolean;
}

interface TextPreview {
  content: string;
  usedLines: number;
  usedBytes: number;
}

function buildTextPreview(text: string, maxLines: number, maxBytes: number): TextPreview {
  if (maxLines <= 0 || maxBytes <= 0) {
    return { content: "", usedLines: 0, usedBytes: 0 };
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const preview: string[] = [];
  let bytes = 0;
  let lineIndex = 0;
  for (; lineIndex < lines.length && lineIndex < maxLines; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const size = Buffer.byteLength(line, "utf8") + (lineIndex > 0 ? 1 : 0);
    if (bytes + size > maxBytes) {
      break;
    }
    preview.push(line);
    bytes += size;
  }
  return {
    content: preview.join("\n"),
    usedLines: preview.length,
    usedBytes: bytes,
  };
}

function mergeDetails(details: any, truncation: TruncationMetadata) {
  const meta: Record<string, unknown> = {
    truncated: true,
    alreadyTruncated: truncation.alreadyTruncated,
    totalLines: truncation.totalLines,
    totalBytes: truncation.totalBytes,
  };
  if (truncation.outputPath) meta.outputPath = truncation.outputPath;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return { ...details, truncation: meta };
  }
  return { truncation: meta };
}

// When the output was already truncated upstream (bash tail footer, read/grep/find
// metadata), the upstream `details.truncation` carries rich fields (truncatedBy,
// outputLines, maxBytes, ...) that tool renderers read. Replacing it wholesale with
// the pi-base marker meta would erase those fields and surface "undefined" in
// truncation warnings, so preserve them and only supplement the marker.
function mergeAlreadyTruncatedDetails(details: any, truncated: TruncationResult): any {
  const existing = details && typeof details === "object" && !Array.isArray(details) ? details.truncation : undefined;
  const meta: Record<string, unknown> = {
    truncated: true,
    alreadyTruncated: true,
    totalLines: truncated.totalLines,
    totalBytes: truncated.totalBytes,
  };
  if (truncated.outputPath) meta.outputPath = truncated.outputPath;
  const mergedTruncation = existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...meta, ...existing, truncated: true, alreadyTruncated: true, ...(truncated.outputPath ? { outputPath: truncated.outputPath } : {}) }
    : meta;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return { ...details, truncation: mergedTruncation };
  }
  return { truncation: mergedTruncation };
}

export async function applyUnifiedOutputTruncation<TDetails>(toolName: string, result: AgentToolResult<TDetails>): Promise<{ result: AgentToolResult<any>; truncated: boolean }> {
  const items = Array.isArray(result?.content) ? result.content : [];
  const textParts = items.filter((item: any) => item?.type === "text").map((item: any) => String(item.text ?? ""));
  if (textParts.length === 0) return { result, truncated: false };

  const combined = textParts.join("\n\n");
  const details = (result as any)?.details;
  const structuredTruncation = details?.truncation;
  const declaredStructuredTruncation = structuredTruncation === true
    || (
      structuredTruncation
      && typeof structuredTruncation === "object"
      && !Array.isArray(structuredTruncation)
      && structuredTruncation.truncated === true
    );
  const declaredUpstreamTruncation = Boolean(
    declaredStructuredTruncation
      || details?.upstreamTextTruncated === true
      || details?.linesTruncated === true
      || (toolName === "bash" && typeof details?.fullOutputPath === "string" && details.fullOutputPath.length > 0),
  );
  const truncated = await truncateTextOutput(
    combined,
    toolName,
    declaredUpstreamTruncation,
    extractDetailsOutputPath(details),
  );
  if (!truncated.truncated) return { result, truncated: false };

  const exceedsFinalLimit = truncated.totalLines > MAX_LINES || truncated.totalBytes > MAX_BYTES;
  if (truncated.alreadyTruncated && !exceedsFinalLimit) {
    return {
      truncated: true,
      result: {
        ...result,
        details: mergeAlreadyTruncatedDetails((result as any).details, truncated),
      },
    };
  }

  const hint = truncated.alreadyTruncated
    ? buildUpstreamRetruncationHint(truncated.outputPath)
    : buildTruncationHint(truncated.totalBytes, truncated.totalLines, truncated.outputPath);
  const unit = truncated.totalBytes > MAX_BYTES ? "bytes" : "lines";
  const maximumRemoved = unit === "bytes" ? truncated.totalBytes : truncated.totalLines;
  const maximumFooter = buildTruncationFooter(maximumRemoved, unit, hint);
  const footerReservation = `\n\n${maximumFooter}`;
  const previewLineLimit = Math.max(0, MAX_LINES - (countLines(footerReservation) - 1));
  const previewByteLimit = Math.max(0, MAX_BYTES - Buffer.byteLength(footerReservation, "utf8"));
  const nextContent: any[] = [];
  let usedLines = 0;
  let usedBytes = 0;
  let seenTextItems = 0;
  let insertedTruncation = false;
  for (const item of items) {
    if (item?.type !== "text") {
      nextContent.push(item);
      continue;
    }
    if (insertedTruncation) continue;

    const text = String(item.text ?? "");
    const separatorLines = seenTextItems > 0 ? 1 : 0;
    const separatorBytes = seenTextItems > 0 ? 2 : 0;
    const itemLines = countLines(text);
    const itemBytes = Buffer.byteLength(text, "utf8");
    if (
      usedLines + separatorLines + itemLines <= previewLineLimit
      && usedBytes + separatorBytes + itemBytes <= previewByteLimit
    ) {
      nextContent.push(item);
      usedLines += separatorLines + itemLines;
      usedBytes += separatorBytes + itemBytes;
      seenTextItems++;
      continue;
    }

    const preview = buildTextPreview(
      text,
      previewLineLimit - usedLines - separatorLines,
      previewByteLimit - usedBytes - separatorBytes,
    );
    const displayedLines = usedLines + separatorLines + preview.usedLines;
    const displayedBytes = usedBytes + separatorBytes + preview.usedBytes;
    const removed = unit === "bytes"
      ? Math.max(0, truncated.totalBytes - displayedBytes)
      : Math.max(0, truncated.totalLines - displayedLines);
    const footer = buildTruncationFooter(removed, unit, hint);
    const previewText = preview.content
      ? `${preview.content}\n\n${footer}`
      : footer;
    nextContent.push({ type: "text" as const, text: previewText });
    insertedTruncation = true;
    seenTextItems++;
  }

  return {
    truncated: true,
    result: {
      ...result,
      content: nextContent,
      details: truncated.alreadyTruncated
        ? mergeAlreadyTruncatedDetails((result as any).details, truncated)
        : mergeDetails((result as any).details, {
          outputPath: truncated.outputPath,
          totalLines: truncated.totalLines,
          totalBytes: truncated.totalBytes,
          alreadyTruncated: false,
        }),
    },
  };
}
