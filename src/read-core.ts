import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { looksLikeBinary } from "./binary-detect.js";
import { buildImageReadDowngradeMessage, modelSupportsImages } from "./image-fallback.js";
import {
  formatHashlineHeader,
  formatNumberedLine,
  InMemorySnapshotStore,
  normalizeToLF,
  splitDisplayedLines,
  stripBom,
} from "./hashline/index.js";
import { SNAPSHOT_MAX_BYTES, recordNormalizedSnapshot } from "./hashline-session.js";
import { LspDiscoveryResolver, type LspSupportInfo } from "./lsp/discovery.js";
import { describeToolWorkdirForDisplay, resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import {
  type CollapsedResultLinesResolver,
  type CollapsedResultMaxCharsResolver,
  formatOptionalArgs,
  renderCallText,
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
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const RESULT_COLLAPSED_LINES = 10;

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
  snapshotOmitted: boolean;
  lsp: LspSupportInfo;
}): string[] {
  const notices: string[] = [];
  if (args.hasMore && args.end >= args.start) {
    notices.push(`[Showing lines ${args.start}-${args.end} of ${args.totalLines}. Re-run read with offset=${args.end + 1} to continue.]`);
  }
  if (args.upstreamTextTruncated) {
    notices.push(`[Some displayed lines were truncated to ${MAX_LINE_CHARS} characters. Re-read a smaller window if you need the full line text.]`);
  }
  if (args.snapshotOmitted) {
    notices.push(`[Snapshot omitted: file is too large for hashline anchoring (${SNAPSHOT_MAX_BYTES} byte cap).]`);
  }
  notices.push(`[${formatLspStatus(args.lsp)}]`);
  return notices;
}

export type ReadLspResolverFactory = (cwd: string) => LspDiscoveryResolver;

export function registerReadTool(
  pi: ExtensionAPI,
  options: {
    onSuccessfulRead?: (absolutePath: string, lines?: string[], meta?: { tag?: string; displayedLines?: number[]; rawPath?: string }) => void;
    createBuiltInReadTool?: ReadFactory;
    createResolver?: ReadLspResolverFactory;
    getCollapsedResultLines?: CollapsedResultLinesResolver;
    getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver;
    snapshots?: InMemorySnapshotStore;
  } = {},
) {
  const tool = {
    name: "read",
    label: "Read",
    description: loadToolDescription("read"),
    promptSnippet: loadToolPromptSnippet("read"),
    parameters: readSchema,
    renderCall(args: any, theme: any, context: any) {
      return renderCallText(formatReadCall(args, theme, context?.cwd), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("read", RESULT_COLLAPSED_LINES, context, options.getCollapsedResultLines);
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
          const result = await builtIn.execute(toolCallId, builtInParams, signal, onUpdate, ctx);
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
                  `message: Image returned as attachment. Hashline anchors are not available for images.${note ? ` ${note}` : ""}`,
                ].join("\n"),
              },
              ...attachments,
            ],
          };
        }

        const buffer = await throwIfAbortedAfter(readFile(absolutePath), signal);
        if (looksLikeBinary(buffer)) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rawPath} appears to be a binary file. read supports text files, directories, and supported images.` }],
            isError: true,
          };
        }

        const offset = parsePositiveInteger(params.offset, "offset", 1);
        const limit = parsePositiveInteger(params.limit, "limit", DEFAULT_LIMIT);
        if (limit > MAX_LIMIT) throw new Error(`limit must be <= ${MAX_LIMIT}.`);

        const { text } = stripBom(buffer.toString("utf8"));
        const normalizedText = normalizeToLF(text);
        const displayedFileLines = splitDisplayedLines(normalizedText);
        const resolverBaseDir = dirname(absolutePath);
        const lsp: LspSupportInfo = options.createResolver
          ? options.createResolver(resolverBaseDir).supportsLsp(absolutePath)
          : { supported: false };
        const start = Math.min(offset, displayedFileLines.length + 1);
        const end = Math.min(displayedFileLines.length, start + limit - 1);
        const body: string[] = [];
        const displayedLines: number[] = [];
        let upstreamTextTruncated = false;
        for (let line = start; line <= end; line++) {
          throwIfAborted(signal);
          const rawLine = displayedFileLines[line - 1] ?? "";
          const formatted = formatLine(rawLine);
          if (formatted.truncated) upstreamTextTruncated = true;
          body.push(formatNumberedLine(line, formatted.display));
          displayedLines.push(line);
        }
        const snapshotOmitted = Boolean(options.snapshots) && buffer.byteLength > SNAPSHOT_MAX_BYTES;
        const tag = options.snapshots && !snapshotOmitted ? recordNormalizedSnapshot(options.snapshots, absolutePath, normalizedText, displayedLines) : undefined;
        const contentLines: string[] = [];
        if (tag) contentLines.push(formatHashlineHeader(rawPath, tag));
        contentLines.push(...body);
        contentLines.push(...buildReadNotices({
          start,
          end,
          totalLines: displayedFileLines.length,
          hasMore: end < displayedFileLines.length,
          upstreamTextTruncated,
          snapshotOmitted,
          lsp,
        }));
        options.onSuccessfulRead?.(absolutePath, displayedFileLines, { tag, displayedLines, rawPath });
        return { content: [{ type: "text" as const, text: contentLines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  };
  pi.registerTool(tool as any);
  return tool;
}
