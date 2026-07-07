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
import { decodeTextFile } from "./text-codec.js";
import { withPiBaseErrorMarker } from "./tool-error-marker.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
type ReadFactory = (cwd: string) => { execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any> };

function parsePositiveInteger(value: unknown, name: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function formatLine(content: string): { display: string; truncated: boolean } {
  const display = content.replace(/\r/g, "\\r").replace(/\u0000/g, "\\0");
  if (display.length > MAX_LINE_CHARS) {
    return {
      display: `${display.slice(0, MAX_LINE_CHARS)}... (line truncated to ${MAX_LINE_CHARS} chars)`,
      truncated: true,
    };
  }
  return { display, truncated: false };
}

function formatNumberedLine(line: number, lineNumberWidth: number, display: string): string {
  return `${String(line).padStart(lineNumberWidth, " ")}|${display}`;
}

function formatReadCall(args: any, theme: any, cwd?: string): string {
  const rawPath = String(args?.path ?? "<missing-path>");
  const path = shortenHomePath(rawPath);
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleOutput(theme, " in ")}${styleAccent(theme, shortenHomePath(rawWorkdir))}`;
  return `${styleToolTitle(theme, "Read")} ${styleAccent(theme, path)}${workdir}${styleOutput(theme, formatOptionalArgs([["offset", args?.offset], ["limit", args?.limit]]))}`;
}

function formatLspStatus(lsp: LspSupportInfo): string {
  if (!lsp.supported) return "lsp: unsupported";
  if (lsp.available) return `lsp: supported (${lsp.language})`;
  return `lsp: file type supported, but server not installed (${lsp.language})`;
}

function buildReadNotices(args: {
  start: number;
  end: number;
  totalLines: number;
  hasMore: boolean;
  upstreamTextTruncated: boolean;
}): string[] {
  const notices: string[] = [];
  if (args.hasMore && args.end >= args.start) {
    notices.push(`[Showing lines ${args.start}-${args.end} of ${args.totalLines}. Re-run read with offset=${args.end + 1} to continue.]`);
  }
  if (args.upstreamTextTruncated) {
    notices.push(`[Some displayed lines were truncated to ${MAX_LINE_CHARS} characters. Re-read a smaller window if you need the full line text.]`);
  }
  return notices;
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
  totalLines: number;
  endsWithNewline: boolean;
  lsp: LspSupportInfo;
}): string[] {
  const header = [
    `path: ${args.rawPath}`,
    `total_lines: ${args.totalLines}`,
    `ends_with_newline: ${args.endsWithNewline ? "yes" : "no"}`,
  ];
  if (args.lsp.supported) {
    header.push(formatLspStatus(args.lsp));
  }
  return header;
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
    renderCall(args: any, theme: any, context: any) {
      return renderStreamingCallText(formatReadCall(args, theme, context?.cwd), theme, context);
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
        const { cwd } = resolveToolWorkdir(params.workdir, ctx.cwd ?? process.cwd());
        const absolutePath = resolveToCwd(rawPath, cwd);
        const st = await throwIfAbortedAfter(stat(absolutePath), signal);

        if (st.isDirectory()) {
          const entries = await throwIfAbortedAfter(readdir(absolutePath, { withFileTypes: true }), signal);
          const names = entries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).sort((a, b) => a.localeCompare(b));
          return { content: [{ type: "text" as const, text: [`path: ${rawPath}`, "kind: directory", "", ...names].join("\n") }] };
        }

        if (IMAGE_EXTENSIONS.has(extname(rawPath).toLowerCase())) {
          if (!modelSupportsImages(ctx?.model)) {
            return { content: [{ type: "text" as const, text: buildImageReadDowngradeMessage(rawPath, absolutePath) }] };
          }
          const builtIn = (options.createBuiltInReadTool ?? createReadTool)(cwd) as {
            execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>;
          };
          const builtInParams = { ...params, path: rawPath };
          delete builtInParams.workdir;
          const result = await withFileMutationQueue(absolutePath, () => builtIn.execute(toolCallId, builtInParams, signal, onUpdate, ctx));
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

        const buffer = await withFileMutationQueue(absolutePath, () => throwIfAbortedAfter(readFile(absolutePath), signal));
        const decodedFile = decodeTextFile(buffer);
        if (decodedFile === null) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rawPath} appears to be a binary file. read supports text files, directories, and supported images.` }],
            isError: true,
          };
        }

        const offset = parsePositiveInteger(params.offset, "offset", 1);
        const limit = parsePositiveInteger(params.limit, "limit", DEFAULT_LIMIT);
        if (limit > MAX_LIMIT) throw new Error(`limit must be <= ${MAX_LIMIT}.`);

        const { text } = decodedFile;
        const { lines: displayedFileLines, endsWithNewline } = buildDisplayedFileLines(text);
        const resolverBaseDir = dirname(absolutePath);
        const lsp: LspSupportInfo = options.createResolver
          ? options.createResolver(resolverBaseDir).supportsLsp(absolutePath)
          : { supported: false };
        const start = Math.min(offset, displayedFileLines.length + 1);
        const end = Math.min(displayedFileLines.length, start + limit - 1);
        const lineNumberWidth = Math.max(1, String(Math.max(displayedFileLines.length, 1)).length);
        const body: string[] = [];
        let upstreamTextTruncated = false;
        for (let line = start; line <= end; line++) {
          throwIfAborted(signal);
          const rawLine = displayedFileLines[line - 1] ?? "";
          const formatted = formatLine(rawLine);
          if (formatted.truncated) upstreamTextTruncated = true;
          body.push(formatNumberedLine(line, lineNumberWidth, formatted.display));
        }
        const contentLines: string[] = [...buildTextReadHeader({ rawPath, totalLines: displayedFileLines.length, endsWithNewline, lsp }), "", ...body];
        contentLines.push(...buildReadNotices({
          start,
          end,
          totalLines: displayedFileLines.length,
          hasMore: end < displayedFileLines.length,
          upstreamTextTruncated,
        }));
        options.onSuccessfulRead?.(absolutePath, displayedFileLines);
        return {
          content: [{ type: "text" as const, text: contentLines.join("\n") }],
          ...(upstreamTextTruncated ? { details: { upstreamTextTruncated: true } } : {}),
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
