import { type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TRUNCATION_DIR_NAME = "pi-base-truncation";

const BASH_TRUNCATION_HINT_REGEX = /\[Showing lines \d+-\d+ of \d+\. Full output: .*?\]/i;
const cleanupStartedDirs = new Set<string>();

function getTruncationDir(): string {
  return join(tmpdir(), TRUNCATION_DIR_NAME);
}

async function ensureTruncationDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (process.platform !== "win32") {
    await chmod(dir, 0o700).catch(() => undefined);
  }
}

function sanitizeToolNameForFilename(toolName: string): string {
  const sanitized = toolName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "tool";
}

async function ensureCleanupScheduled(): Promise<string> {
  const dir = getTruncationDir();
  if (cleanupStartedDirs.has(dir)) return dir;
  cleanupStartedDirs.add(dir);
  try {
    await ensureTruncationDir(dir);
    const now = Date.now();
    const entries = await readdir(dir);
    await Promise.all(entries.map(async (entry) => {
      const filePath = join(dir, entry);
      try {
        const info = await stat(filePath);
        if (now - info.mtimeMs > RETENTION_MS) await rm(filePath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }));
  } catch {
    // ignore cleanup failures
  }
  return dir;
}

async function writeFullOutput(text: string, toolName: string): Promise<string> {
  const dir = await ensureCleanupScheduled();
  await ensureTruncationDir(dir);
  const safeToolName = sanitizeToolNameForFilename(toolName);
  const filePath = join(dir, `${safeToolName}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.txt`);
  try {
    await writeFile(filePath, text, "utf8");
    return filePath;
  } catch (error) {
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function buildTruncationHint(totalBytes: number, totalLines: number, outputPath: string | undefined): string {
  return outputPath
    ? `The tool call succeeded but the output was truncated. Full output (${totalBytes} bytes, ${totalLines} lines) saved to: ${outputPath}\nUse grep to search the full content or read with offset/limit to inspect specific sections.`
    : `The tool call succeeded but the output was truncated. Full output could not be saved to temporary storage (${totalBytes} bytes, ${totalLines} lines).\nRe-run the tool with a narrower scope if you need the omitted content.`;
}

function countLines(text: string): number {
  return text.split("\n").length;
}

interface TruncationResult {
  content: string;
  truncated: boolean;
  outputPath?: string;
  totalLines: number;
  totalBytes: number;
  /**
   * True when our handler observed the output was already truncated by an
   * earlier layer (for example Pi's built-in bash output or read/grep line
   * formatting). In that case we do not have the full text, so we do not
   * write to `pi-base-truncation`. If the earlier layer exposed its own
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

async function truncateTextOutput(text: string, toolName: string, alreadyTruncatedByUpstream = false): Promise<TruncationResult> {
  const totalLines = countLines(text);
  const totalBytes = Buffer.byteLength(text, "utf8");
  alreadyTruncatedByUpstream = alreadyTruncatedByUpstream || (toolName === "bash" && BASH_TRUNCATION_HINT_REGEX.test(text));
  if (alreadyTruncatedByUpstream) {
    return {
      content: text,
      truncated: true,
      outputPath: extractUpstreamOutputPath(text),
      totalLines,
      totalBytes,
      alreadyTruncated: true,
    };
  }
  if (totalLines <= MAX_LINES && totalBytes <= MAX_BYTES) {
    return { content: text, truncated: false, totalLines, totalBytes, alreadyTruncated: false };
  }

  const lines = text.split("\n");
  const preview: string[] = [];
  let bytes = 0;
  let lineIndex = 0;
  let hitBytes = false;
  for (; lineIndex < lines.length && lineIndex < MAX_LINES; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const size = Buffer.byteLength(line, "utf8") + (lineIndex > 0 ? 1 : 0);
    if (bytes + size > MAX_BYTES) {
      hitBytes = true;
      break;
    }
    preview.push(line);
    bytes += size;
  }

  const removed = hitBytes ? totalBytes - bytes : totalLines - preview.length;
  const unit = hitBytes ? "bytes" : "lines";
  let outputPath: string | undefined;
  try {
    outputPath = await writeFullOutput(text, toolName);
  } catch {
    // Keep the bounded preview even when auxiliary full-output storage is unavailable.
  }
  const hint = buildTruncationHint(totalBytes, totalLines, outputPath);

  return {
    content: `${preview.join("\n")}\n\n...${removed} ${unit} truncated...\n\n${hint}`,
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
  hitBytes: boolean;
}

function buildTextPreview(text: string, maxLines: number, maxBytes: number): TextPreview {
  if (maxLines <= 0 || maxBytes <= 0) {
    return { content: "", usedLines: 0, usedBytes: 0, hitBytes: maxBytes <= 0 };
  }
  const lines = text.split("\n");
  const preview: string[] = [];
  let bytes = 0;
  let lineIndex = 0;
  let hitBytes = false;
  for (; lineIndex < lines.length && lineIndex < maxLines; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const size = Buffer.byteLength(line, "utf8") + (lineIndex > 0 ? 1 : 0);
    if (bytes + size > maxBytes) {
      hitBytes = true;
      break;
    }
    preview.push(line);
    bytes += size;
  }
  return {
    content: preview.join("\n"),
    usedLines: preview.length,
    usedBytes: bytes,
    hitBytes,
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
  const declaredUpstreamTruncation = (toolName === "read" || toolName === "grep" || toolName === "find") && Boolean(
    details?.upstreamTextTruncated === true
      || details?.linesTruncated === true
      || details?.truncation,
  );
  const truncated = await truncateTextOutput(combined, toolName, declaredUpstreamTruncation);
  if (!truncated.truncated) return { result, truncated: false };

  if (truncated.alreadyTruncated) {
    return {
      truncated: true,
      result: {
        ...result,
        details: mergeAlreadyTruncatedDetails((result as any).details, truncated),
      },
    };
  }

  const hint = buildTruncationHint(truncated.totalBytes, truncated.totalLines, truncated.outputPath);
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
    if (usedLines + separatorLines + itemLines <= MAX_LINES && usedBytes + separatorBytes + itemBytes <= MAX_BYTES) {
      nextContent.push(item);
      usedLines += separatorLines + itemLines;
      usedBytes += separatorBytes + itemBytes;
      seenTextItems++;
      continue;
    }

    const preview = buildTextPreview(text, MAX_LINES - usedLines - separatorLines, MAX_BYTES - usedBytes - separatorBytes);
    const displayedLines = usedLines + separatorLines + preview.usedLines;
    const displayedBytes = usedBytes + separatorBytes + preview.usedBytes;
    const removed = preview.hitBytes
      ? Math.max(0, truncated.totalBytes - displayedBytes)
      : Math.max(0, truncated.totalLines - displayedLines);
    const unit = preview.hitBytes ? "bytes" : "lines";
    const previewText = preview.content
      ? `${preview.content}\n\n...${removed} ${unit} truncated...\n\n${hint}`
      : `...${removed} ${unit} truncated...\n\n${hint}`;
    nextContent.push({ type: "text" as const, text: previewText });
    insertedTruncation = true;
    seenTextItems++;
  }

  return {
    truncated: true,
    result: {
      ...result,
      content: nextContent,
      details: mergeDetails((result as any).details, {
        outputPath: truncated.outputPath,
        totalLines: truncated.totalLines,
        totalBytes: truncated.totalBytes,
        alreadyTruncated: truncated.alreadyTruncated,
      }),
    },
  };
}
