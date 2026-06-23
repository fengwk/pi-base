import { spawn } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { createGrepTool, DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { ensureTool } from "./internal/pi-coding-agent-utils.js";
import { looksLikeBinary } from "./binary-detect.js";
import { describeToolWorkdirForDisplay, resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import { createGracefulTerminator } from "./process-termination.js";
import { formatOptionalArgs, shortenHomePath, styleAccent, styleMuted, styleOutput, styleToolTitle } from "./render.js";
import { createTimeoutSignal, parsePositiveNumber } from "./timeout.js";

const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_SECONDS = 15;
const BINARY_PROBE_MAX_BYTES = 1024 * 1024;
const BINARY_PROBE_CHUNK_BYTES = 64 * 1024;
const GREP_MAX_LINE_LENGTH = 500;

export const GREP_COLLAPSED_PREVIEW_LINES = 15;
export type GrepFactory = (cwd: string) => { execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => Promise<any> };

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
    ["ignoreCase", args?.ignoreCase === true ? true : undefined],
    ["literal", args?.literal === true ? true : undefined],
    ["multiline", args?.multiline === true ? true : undefined],
    ["limit", args?.limit],
    ["timeout_seconds", args?.timeout_seconds],
  ]);
  return `${styleToolTitle(theme, "grep")} ${styleOutput(theme, pattern)} ${styleMuted(theme, "in")} ${styleAccent(theme, searchPath)}${workdir}${styleOutput(theme, suffix)}`;
}

async function readBinaryProbeBuffer(filePath: string, signal?: AbortSignal): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const totalBytes = Math.min(size, BINARY_PROBE_MAX_BYTES);
    const sample = Buffer.allocUnsafe(totalBytes);
    let offset = 0;
    while (offset < totalBytes) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const { bytesRead } = await handle.read(sample, offset, Math.min(BINARY_PROBE_CHUNK_BYTES, totalBytes - offset), offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return sample.subarray(0, offset);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface MultilineGrepOptions {
  pattern: string;
  absolutePath: string;
  searchPathIsDirectory: boolean;
  include?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  limit: number;
}
interface StandardGrepOptions extends MultilineGrepOptions {
  context: number;
}

async function executeStandardGrep(options: StandardGrepOptions, signal?: AbortSignal): Promise<any> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const rgPath = await ensureTool("rg", true);
  if (!rgPath) throw new Error("ripgrep (rg) is not available and could not be downloaded");
  if (signal?.aborted) throw new Error("Operation aborted");

  return new Promise((resolve, reject) => {
    const args = ["--json", "--line-number", "--color=never", "--hidden"];
    if (options.ignoreCase) args.push("--ignore-case");
    if (options.literal) args.push("--fixed-strings");
    if (options.include) args.push("--glob", options.include);
    args.push("--", options.pattern, options.absolutePath);

    const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const terminator = createGracefulTerminator(child);
    const rl = createInterface({ input: child.stdout });
    let stderr = "";
    let matchCount = 0;
    let matchLimitReached = false;
    let linesTruncated = false;
    let aborted = false;
    let killedDueToLimit = false;
    let settled = false;
    const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
    const outputLines: string[] = [];
    const fileCache = new Map<string, Promise<string[]>>();

    const formatPath = (filePath: string) => {
      if (options.searchPathIsDirectory) {
        const relative = path.relative(options.absolutePath, filePath);
        if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.replace(/\\/g, "/");
      }
      return path.basename(filePath);
    };
    const getFileLines = async (filePath: string) => {
      let linesPromise = fileCache.get(filePath);
      if (!linesPromise) {
        linesPromise = readFile(filePath, "utf8")
          .then((content) => content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n"))
          .catch(() => [] as string[]);
        fileCache.set(filePath, linesPromise);
      }
      return linesPromise;
    };
    const formatBlock = async (filePath: string, lineNumber: number) => {
      const relativePath = formatPath(filePath);
      const lines = await getFileLines(filePath);
      if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
      const block: string[] = [];
      const start = options.context > 0 ? Math.max(1, lineNumber - options.context) : lineNumber;
      const end = options.context > 0 ? Math.min(lines.length, lineNumber + options.context) : lineNumber;
      for (let current = start; current <= end; current++) {
        const lineText = (lines[current - 1] ?? "").replace(/\r/g, "");
        const { text, wasTruncated } = truncateGrepLine(lineText);
        if (wasTruncated) linesTruncated = true;
        if (current === lineNumber) block.push(`${relativePath}:${current}: ${text}`);
        else block.push(`${relativePath}-${current}- ${text}`);
      }
      return block;
    };
    const cleanup = () => {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
      terminator.cleanup();
    };
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    const stopChild = (dueToLimit = false) => {
      killedDueToLimit = dueToLimit;
      terminator.terminate();
    };
    const onAbort = () => {
      aborted = true;
      stopChild();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    rl.on("line", (line) => {
      if (!line.trim() || matchCount >= options.limit) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "match") return;
      matchCount++;
      const filePath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      const lineText = event.data?.lines?.text;
      if (filePath && typeof lineNumber === "number") matches.push({ filePath, lineNumber, lineText });
      if (matchCount >= options.limit) {
        matchLimitReached = true;
        stopChild(true);
      }
    });
    child.on("error", (error) => {
      cleanup();
      settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
    });
    child.on("close", async (code) => {
      cleanup();
      if (aborted) {
        settle(() => reject(new Error("Operation aborted")));
        return;
      }
      if (!killedDueToLimit && code !== 0 && code !== 1) {
        const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
        settle(() => reject(new Error(errorMsg)));
        return;
      }
      if (matchCount === 0) {
        settle(() => resolve({ content: [{ type: "text" as const, text: "No matches found" }], details: undefined }));
        return;
      }
      for (const match of matches) {
        if (options.context === 0 && match.lineText !== undefined) {
          const relativePath = formatPath(match.filePath);
          const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
          const { text, wasTruncated } = truncateGrepLine(sanitized);
          if (wasTruncated) linesTruncated = true;
          outputLines.push(`${relativePath}:${match.lineNumber}: ${text}`);
        } else {
          const block = await formatBlock(match.filePath, match.lineNumber);
          outputLines.push(...block);
        }
      }

      const rawOutput = outputLines.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: Record<string, unknown> = {};
      const notices: string[] = [];
      if (matchLimitReached) {
        notices.push(`${options.limit} matches limit reached. Use limit=${options.limit * 2} for more, or refine pattern`);
        details.matchLimitReached = options.limit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        details.linesTruncated = true;
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

      settle(() => resolve({
        content: [{ type: "text" as const, text: output }],
        details: Object.keys(details).length > 0 ? details : undefined,
      }));
    });
  });
}


function truncateGrepLine(text: string): { text: string; wasTruncated: boolean } {
  if (text.length <= GREP_MAX_LINE_LENGTH) return { text, wasTruncated: false };
  return { text: `${text.slice(0, GREP_MAX_LINE_LENGTH)}…`, wasTruncated: true };
}

function formatGrepMatchPath(filePath: string, absolutePath: string, searchPathIsDirectory: boolean): string {
  if (searchPathIsDirectory) {
    const relative = path.relative(absolutePath, filePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.replace(/\\/g, "/");
  }
  return path.basename(filePath);
}

function formatMultilineMatchLines(filePath: string, lineNumber: number, lineText: string, options: MultilineGrepOptions): { lines: string[]; linesTruncated: boolean } {
  const relativePath = formatGrepMatchPath(filePath, options.absolutePath, options.searchPathIsDirectory);
  const normalized = lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
  const matchedLines = normalized.split("\n");
  let linesTruncated = false;
  const lines = matchedLines.map((line, index) => {
    const { text, wasTruncated } = truncateGrepLine(line);
    if (wasTruncated) linesTruncated = true;
    return `${relativePath}:${lineNumber + index}: ${text}`;
  });
  return { lines, linesTruncated };
}

async function executeMultilineGrep(options: MultilineGrepOptions, signal?: AbortSignal): Promise<any> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const rgPath = await ensureTool("rg", true);
  if (!rgPath) throw new Error("ripgrep (rg) is not available and could not be downloaded");
  if (signal?.aborted) throw new Error("Operation aborted");

  return new Promise((resolve, reject) => {
    const args = ["--json", "--line-number", "--color=never", "--hidden", "--multiline"];
    if (options.ignoreCase) args.push("--ignore-case");
    if (options.literal) args.push("--fixed-strings");
    if (options.include) args.push("--glob", options.include);
    args.push("--", options.pattern, options.absolutePath);

    const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const terminator = createGracefulTerminator(child);
    const rl = createInterface({ input: child.stdout });
    let stderr = "";
    let matchCount = 0;
    let matchLimitReached = false;
    let linesTruncated = false;
    let aborted = false;
    let killedDueToLimit = false;
    let settled = false;
    const outputLines: string[] = [];

    const cleanup = () => {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
      terminator.cleanup();
    };
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    const stopChild = (dueToLimit = false) => {
      killedDueToLimit = dueToLimit;
      terminator.terminate();
    };
    const onAbort = () => {
      aborted = true;
      stopChild();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    rl.on("line", (line) => {
      if (!line.trim() || matchCount >= options.limit) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "match") return;

      matchCount++;
      const filePath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      const lineText = event.data?.lines?.text;
      if (filePath && typeof lineNumber === "number" && typeof lineText === "string") {
        const formatted = formatMultilineMatchLines(filePath, lineNumber, lineText, options);
        outputLines.push(...formatted.lines);
        if (formatted.linesTruncated) linesTruncated = true;
      }
      if (matchCount >= options.limit) {
        matchLimitReached = true;
        stopChild(true);
      }
    });

    child.on("error", (error) => {
      cleanup();
      settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
    });

    child.on("close", (code) => {
      cleanup();
      if (aborted) {
        settle(() => reject(new Error("Operation aborted")));
        return;
      }
      if (!killedDueToLimit && code !== 0 && code !== 1) {
        const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
        settle(() => reject(new Error(errorMsg)));
        return;
      }
      if (matchCount === 0) {
        settle(() => resolve({ content: [{ type: "text" as const, text: "No matches found" }], details: undefined }));
        return;
      }

      let output = outputLines.join("\n");
      const details: any = {};
      const notices: string[] = [];
      if (matchLimitReached) {
        notices.push(`${options.limit} matches limit reached. Use limit=${options.limit * 2} for more, or refine pattern`);
        details.matchLimitReached = options.limit;
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        details.linesTruncated = true;
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

      settle(() => resolve({
        content: [{ type: "text" as const, text: output }],
        details: Object.keys(details).length > 0 ? details : undefined,
      }));
    });
  });
}

export async function executeGrep(params: any, signal?: AbortSignal, onUpdate?: any, ctx: any = {}, createBuiltInGrepTool?: GrepFactory): Promise<any> {
  try {
    const pattern = String(params.pattern ?? "");
    const rawPath = String(params.path ?? "").replace(/^@/, "");
    if (!pattern) throw new Error("pattern is required.");
    if (!rawPath) throw new Error("path is required.");
    const { cwd } = resolveToolWorkdir(params.workdir, ctx.cwd ?? process.cwd());
    const absolutePath = resolveToCwd(rawPath, cwd);
    const timeoutSeconds = parsePositiveNumber(params.timeout_seconds, "timeout_seconds", DEFAULT_TIMEOUT_SECONDS);
    const limit = parsePositiveNumber(params.limit, "limit", DEFAULT_LIMIT);
    const multiline = params.multiline === true;

    const timeout = createTimeoutSignal(signal, timeoutSeconds);
    try {
      let searchPathIsDirectory = false;
      try {
        searchPathIsDirectory = (await stat(absolutePath)).isDirectory();
      } catch {
        searchPathIsDirectory = false;
      }
      if (!searchPathIsDirectory) {
        try {
          const buffer = await readBinaryProbeBuffer(absolutePath, timeout.signal);
          if (looksLikeBinary(buffer)) {
            return {
              content: [{ type: "text" as const, text: `Error: ${rawPath} appears to be a binary file. grep only supports searching text files or directories.` }],
              isError: true,
            };
          }
        } catch (error) {
          if ((error as Error).message === "Operation aborted") throw error;
        }
      }

      if (multiline && !createBuiltInGrepTool) {
        return await executeMultilineGrep({
          pattern,
          absolutePath,
          searchPathIsDirectory,
          include: params.include,
          ignoreCase: params.ignoreCase === true,
          literal: params.literal === true,
          limit,
        }, timeout.signal);
      }

      if (!createBuiltInGrepTool) {
        return await executeStandardGrep({
          pattern,
          absolutePath,
          searchPathIsDirectory,
          include: params.include,
          ignoreCase: params.ignoreCase === true,
          literal: params.literal === true,
          limit,
          context: typeof params.context === "number" ? params.context : Number(params.context ?? 0) || 0,
        }, timeout.signal);
      }

      const builtIn = createBuiltInGrepTool(cwd);
      return await builtIn.execute(toolCallIdPlaceholder, {
        path: rawPath,
        pattern,
        glob: params.include,
        ignoreCase: params.ignoreCase === true,
        literal: params.literal === true,
        timeout: timeoutSeconds,
        limit,
        ...(params.multiline === true ? { multiline: true } : {}),
      } as any, timeout.signal, onUpdate);
    } catch (error) {
      if (timeout.didTimeout()) {
        return { content: [{ type: "text" as const, text: `Error: Search timed out after ${timeoutSeconds}s.` }], isError: true };
      }
      throw error;
    } finally {
      timeout.cleanup();
    }
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
  }
}

const toolCallIdPlaceholder = "grep";
