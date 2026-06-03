import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGrepTool } from "@earendil-works/pi-coding-agent";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeToLF, stripBom } from "./edit-diff.js";
import { looksLikeBinary } from "./binary-detect.js";
import { ensureHashInit, escapeControlCharsForDisplay, formatHashlineDisplay } from "./hashline.js";
import { resolveToCwd } from "./path-utils.js";
import { type CollapsedResultLinesResolver, formatOptionalArgs, renderCallText, renderRawResult, resolveCollapsedResultLines, shortenHomePath, styleAccent, styleMuted, styleOutput, styleToolTitle } from "./render.js";
import { grepSchema } from "./schemas/grep.js";
import { createTimeoutSignal, parsePositiveNumber } from "./timeout.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";

const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_SECONDS = 15;
const MATCH_LINE_RE = /^(.*):(\d+): (.*)$/;
const MAX_LINE_CHARS = 2000;
const BINARY_PROBE_MAX_BYTES = 1024 * 1024;
const BINARY_PROBE_CHUNK_BYTES = 64 * 1024;
const RESULT_COLLAPSED_LINES = 15;

type GrepFactory = (cwd: string) => { execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => Promise<any> };

function formatGrepPattern(value: unknown): string {
  if (value === undefined || value === null) return "<missing-pattern>";
  return JSON.stringify(String(value));
}

function formatGrepCall(args: any, theme: any): string {
  const pattern = formatGrepPattern(args?.pattern);
  const path = shortenHomePath(String(args?.path ?? "<missing-path>"));
  const suffix = formatOptionalArgs([
    ["include", args?.include],
    ["ignoreCase", args?.ignoreCase === true ? true : undefined],
    ["literal", args?.literal === true ? true : undefined],
    ["limit", args?.limit],
    ["timeoutSeconds", args?.timeoutSeconds],
  ]);
  return `${styleToolTitle(theme, "grep")} ${styleOutput(theme, pattern)} ${styleMuted(theme, "in")} ${styleAccent(theme, path)}${styleOutput(theme, suffix)}`;
}

function formatMatchLine(content: string): { display: string; truncated: boolean } {
  const display = escapeControlCharsForDisplay(content);
  if (display.length <= MAX_LINE_CHARS) return { display, truncated: false };
  return {
    display: `${display.slice(0, MAX_LINE_CHARS)}... (line truncated to ${MAX_LINE_CHARS} chars)`,
    truncated: true,
  };
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

export function registerGrepTool(
  pi: ExtensionAPI,
  options: { onFileAnchored?: (absolutePath: string, lines?: string[]) => void; createBuiltInGrepTool?: GrepFactory; getCollapsedResultLines?: CollapsedResultLinesResolver } = {},
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
      return renderRawResult(result, { ...renderOptions, collapsedLines }, _theme, context);
    },
    async execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx: any = {}) {
      try {
        await ensureHashInit();
        const pattern = String(params.pattern ?? "");
        const rawPath = String(params.path ?? "").replace(/^@/, "");
        if (!pattern) throw new Error("pattern is required.");
        if (!rawPath) throw new Error("path is required.");
        const cwd = ctx.cwd ?? process.cwd();
        const absolutePath = resolveToCwd(rawPath, cwd);
        const timeoutSeconds = parsePositiveNumber(params.timeoutSeconds, "timeoutSeconds", DEFAULT_TIMEOUT_SECONDS);
        const limit = parsePositiveNumber(params.limit, "limit", DEFAULT_LIMIT);

        const timeout = createTimeoutSignal(signal, timeoutSeconds);

        // Reject single-file binary paths before delegating to upstream rg.
        // Doing this check after rg runs is unsafe because rg can stall on
        // binary content — the check would never be reached, and the tool
        // would hang until the caller's timeout fires.
        //
        // Probe only a bounded prefix of the file. This keeps the pre-check
        // abortable-ish and avoids loading arbitrarily large files into memory
        // before we have even decided whether grep should run.
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
            // fall through to upstream grep
          }
        }

        try {
          const builtIn = (options.createBuiltInGrepTool ?? createGrepTool)(cwd);
          const result = await builtIn.execute(
            toolCallId,
            {
              pattern,
              path: rawPath,
              glob: params.include,
              ignoreCase: params.ignoreCase,
              literal: params.literal,
              limit,
            },
            timeout.signal,
            onUpdate,
          );

          const text = (result.content?.find((item: any) => item.type === "text") as any)?.text ?? "";
          if (!text) return result;
          if ((result as any).isError) return result;
          if (text.startsWith("No matches found")) return result;

          const fileCache = new Map<string, string[]>();
          const loadLines = async (filePath: string): Promise<string[]> => {
            let cached = fileCache.get(filePath);
            if (!cached) {
              const content = await readFile(filePath, "utf8");
              // Raw `split("\n")`: keep the implicit empty line from
              // a trailing newline. `grep` shows the file as it is.
              cached = normalizeToLF(stripBom(content).text).split("\n");
              fileCache.set(filePath, cached);
            }
            return cached;
          };

          const output: string[] = [];
          const anchoredFiles = new Set<string>();
          let totalMatches = 0;
          let upstreamTextTruncated = false;
          for (const line of text.split("\n")) {
            const match = line.match(MATCH_LINE_RE);
            if (!match) {
              output.push(line);
              continue;
            }
            const displayPath = match[1];
            const lineNumber = Number.parseInt(match[2], 10);
            const absoluteMatchPath = searchPathIsDirectory ? path.resolve(absolutePath, displayPath) : absolutePath;
            const lines = await loadLines(absoluteMatchPath);
            const rawLine = lines[lineNumber - 1] ?? match[3];
            const width = String(lines.length).length;
            const formatted = formatMatchLine(rawLine);
            if (formatted.truncated) upstreamTextTruncated = true;
            output.push(displayPath);
            output.push(formatHashlineDisplay(lineNumber, rawLine, width, formatted.display));
            anchoredFiles.add(absoluteMatchPath);
            totalMatches++;
          }

          for (const anchoredFile of anchoredFiles) {
            options.onFileAnchored?.(anchoredFile, fileCache.get(anchoredFile));
          }
          return {
            content: [{
              type: "text" as const,
              text: [`pattern: ${formatGrepPattern(pattern)}`, `path: ${rawPath}`, ...(params.literal ? ["literal: true"] : []), `totalMatches: ${totalMatches}`, "", ...output].join("\n"),
            }],
            ...(upstreamTextTruncated ? { details: { upstreamTextTruncated: true } } : {}),
          };
        } catch (error) {
          if (timeout.didTimeout()) {
            return {
              content: [{ type: "text" as const, text: `Error: Search timed out after ${timeoutSeconds}s.\nHint: Large-scale scans are discouraged. Narrow the path or pattern first. If a broad scan is truly necessary, rerun grep with an explicit timeoutSeconds value.` }],
              isError: true,
            };
          }
          throw error;
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
