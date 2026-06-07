import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGrepTool } from "@earendil-works/pi-coding-agent";
import { open, stat } from "node:fs/promises";
import { looksLikeBinary } from "./binary-detect.js";
import { resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import { type CollapsedResultLinesResolver, type CollapsedResultMaxCharsResolver, formatOptionalArgs, renderCallText, renderRawResult, resolveCollapsedResultLines, resolveCollapsedResultMaxChars, shortenHomePath, styleAccent, styleMuted, styleOutput, styleToolTitle } from "./render.js";
import { grepSchema } from "./schemas/grep.js";
import { createTimeoutSignal, parsePositiveNumber } from "./timeout.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";

const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_SECONDS = 15;
const BINARY_PROBE_MAX_BYTES = 1024 * 1024;
const BINARY_PROBE_CHUNK_BYTES = 64 * 1024;
const RESULT_COLLAPSED_LINES = 15;
const GREP_MAX_LINE_LENGTH = 500;

type GrepFactory = (cwd: string) => { execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => Promise<any> };

function formatGrepPattern(value: unknown): string {
  if (value === undefined || value === null) return "<missing-pattern>";
  return JSON.stringify(String(value));
}

function formatGrepCall(args: any, theme: any): string {
  const pattern = formatGrepPattern(args?.pattern);
  const path = shortenHomePath(String(args?.path ?? "<missing-path>"));
  const workdir = `${styleMuted(theme, " from ")}${styleAccent(theme, args?.workdir === undefined ? "<missing-workdir>" : shortenHomePath(String(args.workdir)))}`;
  const suffix = formatOptionalArgs([
    ["include", args?.include],
    ["ignoreCase", args?.ignoreCase === true ? true : undefined],
    ["literal", args?.literal === true ? true : undefined],
    ["multiline", args?.multiline === true ? true : undefined],
    ["limit", args?.limit],
    ["timeout_seconds", args?.timeout_seconds],
  ]);
  return `${styleToolTitle(theme, "grep")} ${styleOutput(theme, pattern)} ${styleMuted(theme, "in")} ${styleAccent(theme, path)}${workdir}${styleOutput(theme, suffix)}`;
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
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }

    const args = ["--json", "--line-number", "--color=never", "--hidden", "--multiline"];
    if (options.ignoreCase) args.push("--ignore-case");
    if (options.literal) args.push("--fixed-strings");
    if (options.include) args.push("--glob", options.include);
    args.push("--", options.pattern, options.absolutePath);

    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
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
    };
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    const stopChild = (dueToLimit = false) => {
      if (!child.killed) {
        killedDueToLimit = dueToLimit;
        child.kill();
      }
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
export function registerGrepTool(
  pi: ExtensionAPI,
  options: { createBuiltInGrepTool?: GrepFactory; getCollapsedResultLines?: CollapsedResultLinesResolver; getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver } = {},
) {
  const tool = {
    name: "grep",
    label: "grep",
    description: loadToolDescription("grep"),
    promptSnippet: loadToolPromptSnippet("grep"),
    parameters: grepSchema,
    renderCall(args: any, _theme: any, context: any) {
      return renderCallText(formatGrepCall(args, _theme), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, _theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("grep", RESULT_COLLAPSED_LINES, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("grep", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(result, { ...renderOptions, collapsedLines, maxCollapsedChars }, _theme, context);
    },
    async execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx: any = {}) {
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
          // Reject single-file binary paths before delegating to upstream rg.
          // Doing this check after rg runs is unsafe because rg can stall on
          // binary content — the check would never be reached, and the tool
          // would hang until the caller's timeout fires.
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
                  content: [{ type: "text" as const, text: `Error: ${rawPath} appears to be a binary file. grep only supports searching text files.` }],
                  isError: true,
                };
              }
            } catch {
              // Fall through to upstream grep for path-not-found and transient read errors.
            }
          }

          try {
            if (multiline && !options.createBuiltInGrepTool) {
              return await executeMultilineGrep(
                {
                  pattern,
                  absolutePath,
                  searchPathIsDirectory,
                  include: params.include,
                  ignoreCase: params.ignoreCase,
                  literal: params.literal,
                  limit,
                },
                timeout.signal,
              );
            }

            const builtIn = ((options.createBuiltInGrepTool ?? createGrepTool) as GrepFactory)(cwd);
            return await builtIn.execute(
              toolCallId,
              {
                pattern,
                path: rawPath,
                glob: params.include,
                ignoreCase: params.ignoreCase,
                literal: params.literal,
                limit,
                multiline,
              },
              timeout.signal,
              onUpdate,
            );
          } catch (error) {
            if (timeout.didTimeout()) {
              return {
                content: [{ type: "text" as const, text: `Error: Search timed out after ${timeoutSeconds}s.\nHint: Large-scale scans are discouraged. Narrow the path or pattern first. If a broad scan is truly necessary, rerun grep with an explicit timeout_seconds value.` }],
                isError: true,
              };
            }
            throw error;
          }
        } finally {
          timeout.cleanup();
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  };
  pi.registerTool(tool as any);
  return tool;
}
