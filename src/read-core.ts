import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { buildImageReadDowngradeMessage, modelSupportsImages } from "./image-fallback.js";
import { normalizeToLF } from "./line-endings.js";
import { LspDiscoveryResolver, type LspSupportInfo } from "./lsp/discovery.js";
import { describeToolWorkdirForDisplay, resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import {
  type CollapsedResultLinesResolver,
  type CollapsedResultMaxCharsResolver,
  formatOptionalArgs,
  renderStreamingCallText,
  renderRawResult,
  resolveCollapsedResultLines,
  resolveCollapsedResultMaxChars,
  shortenHomePath,
  styleAccent,
  styleOutput,
  styleToolTitle,
} from "./render.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";
import { readSchema } from "./schemas/read.js";
import { mapFilePathToPath } from "./tool-arg-aliases.js";
import { decodeTextFile } from "./text-codec.js";
import { TOOL_OUTPUT_MAX_BYTES, TOOL_OUTPUT_MAX_LINES } from "./tool-output-core.js";
import { withPiBaseErrorMarker } from "./tool-error-marker.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const MAX_LINE_CODE_POINTS = 2000;
const MAX_TEXT_FILE_BYTES = 64 * 1024 * 1024;
// Continuation notices share the final output budget with the body, so the
// window reserves room for the blank separator plus the notice lines up front.
const NOTICE_RESERVE_LINES = 3;
const NOTICE_RESERVE_BYTES = 1024;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
type ReadFactory = (cwd: string) => { execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any> };

/**
 * MiniMax-M3 has been observed to emit `read({})` while trying to inspect a
 * workspace, then repeat the empty call after validation errors. Interpret only
 * an exact empty object as the current directory; partially populated calls
 * remain invalid rather than guessing a missing path.
 */
export function prepareReadArguments(args: unknown): unknown {
  const mappedArgs = mapFilePathToPath(args);
  if (
    mappedArgs !== null
    && typeof mappedArgs === "object"
    && !Array.isArray(mappedArgs)
    && Object.keys(mappedArgs).length === 0
  ) {
    return { path: "." };
  }
  return mappedArgs;
}

function parsePositiveInteger(value: unknown, name: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function assertTextFileSize(rawPath: string, size: number): void {
  if (size <= MAX_TEXT_FILE_BYTES) return;
  throw new Error(
    `${rawPath} is larger than the 64 MiB read safety limit. `
    + "Use grep to locate relevant text or narrow the target before reading; offset/limit cannot safely load this whole file.",
  );
}

function assertRegularReadFile(rawPath: string, fileStat: { isFile: () => boolean }): void {
  if (fileStat.isFile()) return;
  throw new Error(`${rawPath} is not a regular file. read supports text files, directories, and supported images.`);
}

function rejectExplicitColumnOffset(params: any): void {
  if (params?.column_offset !== undefined) {
    throw new Error("column_offset is only supported for text file reads.");
  }
}

function codePointSize(code: number, nextCode: number): number {
  return code >= 0xd800 && code < 0xdc00 && nextCode >= 0xdc00 && nextCode < 0xe000 ? 2 : 1;
}

function countCodePoints(line: string): number {
  let count = 0;
  for (let index = 0; index < line.length; ) {
    index += codePointSize(line.charCodeAt(index), line.charCodeAt(index + 1));
    count += 1;
  }
  return count;
}

function skipToCodePointColumn(line: string, column: number): number | null {
  let index = 0;
  let current = 1;
  while (current < column) {
    if (index >= line.length) return null;
    index += codePointSize(line.charCodeAt(index), line.charCodeAt(index + 1));
    current += 1;
  }
  return index;
}

interface LineFragment {
  display: string;
  complete: boolean;
  codePoints: number;
}

/**
 * Iterates the line by Unicode code points and collects at most the display
 * fragment, so potentially huge lines are never materialized as arrays and
 * surrogate pairs are never split at the fragment boundary.
 */
function extractLineFragment(line: string, startIndex: number): LineFragment {
  const pieces: string[] = [];
  let index = startIndex;
  let collected = 0;
  while (collected < MAX_LINE_CODE_POINTS && index < line.length) {
    const code = line.charCodeAt(index);
    const size = codePointSize(code, line.charCodeAt(index + 1));
    if (code === 13) pieces.push("\\r");
    else if (code === 0) pieces.push("\\0");
    else pieces.push(line.slice(index, index + size));
    index += size;
    collected += 1;
  }
  const complete = index >= line.length;
  const fragment = pieces.join("");
  return {
    display: complete ? fragment : `${fragment}... (line truncated to ${MAX_LINE_CODE_POINTS} chars)`,
    complete,
    codePoints: collected,
  };
}

function formatNumberedLine(line: number, lineNumberWidth: number, display: string): string {
  return `${String(line).padStart(lineNumberWidth, " ")}|${display}`;
}

function formatReadCall(args: any, theme: any, cwd?: string): string {
  const rawPath = String(args?.path ?? "<missing-path>");
  const path = shortenHomePath(rawPath);
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleOutput(theme, " in ")}${styleAccent(theme, shortenHomePath(rawWorkdir))}`;
  return `${styleToolTitle(theme, "Read")} ${styleAccent(theme, path)}${workdir}${styleOutput(theme, formatOptionalArgs([["offset", args?.offset], ["limit", args?.limit], ["column_offset", args?.column_offset]]))}`;
}

function formatLspStatus(lsp: LspSupportInfo): string {
  if (!lsp.supported) return "lsp: unsupported";
  if (lsp.available) return `lsp: supported (${lsp.language})`;
  return `lsp: file type supported, but server not installed (${lsp.language})`;
}

interface ReadNextPosition {
  line: number;
  column: number;
}

function buildReadNotices(args: {
  start: number;
  end: number;
  totalLines: number;
  next: ReadNextPosition | null;
  lineCapped: boolean;
}): string[] {
  const next = args.next;
  if (next === null) return [];
  if (args.lineCapped) {
    const rest = next.line < args.totalLines ? `; lines after ${next.line} were not shown` : "";
    return [
      `[Line ${next.line} was cut at column ${next.column}${rest}. `
      + `Re-run read with offset=${next.line}, column_offset=${next.column} to continue this line.]`,
    ];
  }
  if (args.end >= args.start) {
    return [`[Showing lines ${args.start}-${args.end} of ${args.totalLines}. Re-run read with offset=${next.line} to continue.]`];
  }
  return [`[Line ${next.line} was not displayed within the output budget. Re-run read with offset=${next.line} to continue.]`];
}

function buildDisplayedFileLines(text: string): { lines: string[]; endsWithNewline: boolean } {
  const normalizedText = normalizeToLF(text);
  const endsWithNewline = text.endsWith("\n") || text.endsWith("\r");
  const lines = normalizedText.length === 0 ? [] : normalizedText.split("\n");
  // Drop the trailing empty element produced by a final newline so the numbered
  // body only represents content-bearing lines and explicit blank lines.
  if (endsWithNewline && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return { lines, endsWithNewline };
}

function buildTextReadHeader(args: {
  rawPath: string;
  endsWithNewline: boolean;
  lsp: LspSupportInfo;
  columnOffset: number;
}): string[] {
  return [
    `path: ${args.rawPath}`,
    `ends_with_newline: ${args.endsWithNewline ? "yes" : "no"}`,
    formatLspStatus(args.lsp),
    ...(args.columnOffset > 1
      ? [`column_offset: ${args.columnOffset} (first displayed line starts mid-line; earlier columns omitted)`]
      : []),
  ];
}

export type ReadLspResolverFactory = (cwd: string) => LspDiscoveryResolver;

export function registerReadTool(
  pi: ExtensionAPI,
  options: {
    onSuccessfulRead?: (absolutePath: string, lines?: string[]) => void;
    createBuiltInReadTool?: ReadFactory;
    createResolver?: ReadLspResolverFactory;
    getCollapsedResultLines?: CollapsedResultLinesResolver;
    getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver;
  } = {},
) {
  const tool = {
    name: "read",
    label: "Read",
    description: loadToolDescription("read"),
    promptSnippet: loadToolPromptSnippet("read"),
    parameters: readSchema,
    prepareArguments(args: unknown) {
      return prepareReadArguments(args);
    },
    renderCall(args: any, theme: any, context: any) {
      // An empty object is also the initial streaming state before any arguments arrive.
      // Apply the fallback only after streaming ends or execution starts.
      const isStreamingArgs = context?.argsComplete === false
        && !context?.executionStarted
        && context?.isPartial !== false;
      const mappedArgs = isStreamingArgs
        ? mapFilePathToPath(args)
        : prepareReadArguments(args);
      return renderStreamingCallText(formatReadCall(mappedArgs, theme, context?.cwd), theme, context);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("read", undefined, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("read", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(result, { ...renderOptions, collapsedLines, maxCollapsedChars }, theme, context);
    },
    async execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx: any = {}) {
      try {
        throwIfAborted(signal);
        const rawPath = String(params.path ?? "").replace(/^@/, "");
        if (!rawPath) throw new Error("path is required.");
        const offset = parsePositiveInteger(params.offset, "offset", 1);
        const limit = parsePositiveInteger(params.limit, "limit", DEFAULT_LIMIT);
        if (limit > MAX_LIMIT) throw new Error(`limit must be <= ${MAX_LIMIT}.`);
        const columnOffset = parsePositiveInteger(params.column_offset, "column_offset", 1);
        const { cwd } = resolveToolWorkdir(params.workdir, ctx.cwd ?? process.cwd());
        const absolutePath = resolveToCwd(rawPath, cwd);
        const st = await throwIfAbortedAfter(stat(absolutePath), signal);

        if (st.isDirectory()) {
          rejectExplicitColumnOffset(params);
          const entries = await throwIfAbortedAfter(readdir(absolutePath, { withFileTypes: true }), signal);
          const names = entries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).sort((a, b) => a.localeCompare(b));
          return { content: [{ type: "text" as const, text: [`path: ${rawPath}`, "kind: directory", "", ...names].join("\n") }] };
        }
        assertRegularReadFile(rawPath, st);

        if (IMAGE_EXTENSIONS.has(extname(rawPath).toLowerCase())) {
          rejectExplicitColumnOffset(params);
          if (!modelSupportsImages(ctx?.model)) {
            return { content: [{ type: "text" as const, text: buildImageReadDowngradeMessage(rawPath, absolutePath) }] };
          }
          const builtIn = (options.createBuiltInReadTool ?? createReadTool)(cwd) as {
            execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>;
          };
          const builtInParams = { ...params, path: rawPath };
          delete builtInParams.workdir;
          const result = await withFileMutationQueue(absolutePath, async () => {
            const currentStat = await throwIfAbortedAfter(stat(absolutePath), signal);
            assertRegularReadFile(rawPath, currentStat);
            return builtIn.execute(toolCallId, builtInParams, signal, onUpdate, ctx);
          });
          const note = (result.content ?? [])
            .filter((item: any) => item.type === "text" && typeof item.text === "string")
            .map((item: any) => item.text)
            .join("\n")
            .trim();
          const attachments = (result.content ?? []).filter((item: any) => item.type !== "text");
          return {
            ...result,
            content: [
              {
                type: "text" as const,
                text: [
                  `path: ${rawPath}`,
                  "kind: file",
                  "mediaType: image",
                  `message: Image returned as attachment.${note ? ` ${note}` : ""}`,
                ].join("\n"),
              },
              ...attachments,
            ],
          };
        }

        assertTextFileSize(rawPath, st.size);

        const buffer = await withFileMutationQueue(absolutePath, async () => {
          const currentStat = await throwIfAbortedAfter(stat(absolutePath), signal);
          assertRegularReadFile(rawPath, currentStat);
          assertTextFileSize(rawPath, currentStat.size);
          return throwIfAbortedAfter(readFile(absolutePath), signal);
        });
        const decodedFile = decodeTextFile(buffer);
        if (decodedFile === null) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rawPath} appears to be a binary file. read supports text files, directories, and supported images.` }],
            isError: true,
          };
        }

        const { text } = decodedFile;
        const { lines: displayedFileLines, endsWithNewline } = buildDisplayedFileLines(text);
        const resolverBaseDir = dirname(absolutePath);
        const lsp: LspSupportInfo = options.createResolver
          ? options.createResolver(resolverBaseDir).supportsLsp(absolutePath)
          : { supported: false };
        const totalLines = displayedFileLines.length;
        const start = Math.min(offset, totalLines + 1);

        let firstLineStartIndex = 0;
        if (start > totalLines) {
          if (columnOffset !== 1) {
            throw new Error(`column_offset ${columnOffset} is invalid: line ${start} does not exist (the file has ${totalLines} lines).`);
          }
        } else if (columnOffset > 1) {
          const firstLine = displayedFileLines[start - 1]!;
          const skipped = skipToCodePointColumn(firstLine, columnOffset);
          if (skipped === null || skipped === firstLine.length) {
            throw new Error(`column_offset ${columnOffset} is out of bounds for line ${start} (${countCodePoints(firstLine)} code points).`);
          }
          firstLineStartIndex = skipped;
        }

        const headerLines = buildTextReadHeader({ rawPath, endsWithNewline, lsp, columnOffset });
        const headerText = headerLines.join("\n");
        const headerBytes = Buffer.byteLength(headerText, "utf8") + 2;
        const maxBodyLines = Math.min(limit, MAX_LIMIT, TOOL_OUTPUT_MAX_LINES - headerText.split("\n").length - 1 - NOTICE_RESERVE_LINES);
        const maxBodyBytes = TOOL_OUTPUT_MAX_BYTES - headerBytes - NOTICE_RESERVE_BYTES;
        if (maxBodyLines < 1 || maxBodyBytes < 1) {
          throw new Error("Read metadata exceeds the output budget. Use a shorter path.");
        }
        const lineNumberWidth = Math.max(1, String(Math.max(totalLines, 1)).length);
        const body: string[] = [];
        let bodyBytes = 0;
        let upstreamTextTruncated = false;
        let next: ReadNextPosition | null = null;
        let line = start;
        while (line <= totalLines) {
          throwIfAborted(signal);
          if (body.length >= maxBodyLines) break;
          const rawLine = displayedFileLines[line - 1]!;
          const fragment = extractLineFragment(rawLine, line === start ? firstLineStartIndex : 0);
          const physical = formatNumberedLine(line, lineNumberWidth, fragment.display);
          const physicalBytes = Buffer.byteLength(physical, "utf8") + 1;
          if (bodyBytes + physicalBytes > maxBodyBytes) break;
          body.push(physical);
          bodyBytes += physicalBytes;
          if (!fragment.complete) {
            // The fragment hit the per-line cap: stop the window here so later
            // lines never appear before this line's remainder is shown.
            upstreamTextTruncated = true;
            next = { line, column: (line === start ? columnOffset : 1) + fragment.codePoints };
            break;
          }
          line += 1;
        }
        if (body.length === 0 && line <= totalLines) {
          throw new Error("Read output cannot fit the first line fragment. Use a shorter path.");
        }
        if (next === null && line <= totalLines) next = { line, column: 1 };
        const end = start + body.length - 1;
        const notices = buildReadNotices({ start, end, totalLines, next, lineCapped: upstreamTextTruncated });
        const contentLines: string[] = [
          ...headerLines,
          "",
          ...body,
          ...(notices.length > 0 ? ["", ...notices] : []),
        ];
        try {
          options.onSuccessfulRead?.(absolutePath, displayedFileLines);
        } catch {
          // Observer failures cannot invalidate the completed read.
        }
        const details: Record<string, unknown> = {};
        if (upstreamTextTruncated) details.upstreamTextTruncated = true;
        if (next !== null) details.next = { line: next.line, column: next.column };
        return {
          content: [{ type: "text" as const, text: contentLines.join("\n") }],
          ...(Object.keys(details).length > 0 ? { details } : {}),
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  };
  const markedTool = withPiBaseErrorMarker(tool);
  pi.registerTool(markedTool as any);
  return markedTool;
}
