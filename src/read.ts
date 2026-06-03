import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { looksLikeBinary } from "./binary-detect.js";
import { normalizeToLF, stripBom } from "./edit-diff.js";
import { ensureHashInit, escapeControlCharsForDisplay, formatHashlineDisplay } from "./hashline.js";
import { LspDiscoveryResolver, type LspSupportInfo } from "./lsp/discovery.js";
import { resolveToCwd } from "./path-utils.js";
import { type CollapsedResultLinesResolver, formatOptionalArgs, renderCallText, renderRawResult, resolveCollapsedResultLines, shortenHomePath, styleAccent, styleOutput, styleToolTitle } from "./render.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";
import { readSchema } from "./schemas/read.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const RESULT_COLLAPSED_LINES = 10;

function parsePositiveInteger(value: unknown, name: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function formatLine(content: string): { display: string; truncated: boolean } {
  let display = escapeControlCharsForDisplay(content);
  if (display.length > MAX_LINE_CHARS) {
    return {
      display: `${display.slice(0, MAX_LINE_CHARS)}... (line truncated to ${MAX_LINE_CHARS} chars)`,
      truncated: true,
    };
  }
  return { display, truncated: false };
}

type ReadFactory = (cwd: string) => { execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => Promise<any> };

function formatReadCall(args: any, theme: any): string {
  const rawPath = String(args?.path ?? "<missing-path>");
  const path = shortenHomePath(rawPath);
  return `${styleToolTitle(theme, "Read")} ${styleAccent(theme, path)}${styleOutput(theme, formatOptionalArgs([["offset", args?.offset], ["limit", args?.limit]]))}`;
}

function formatLspStatus(lsp: LspSupportInfo): string {
  if (!lsp.supported) return "lsp: unsupported";
  if (lsp.available) return `lsp: supported (${lsp.language})`;
  return `lsp: file type supported, but server not installed (${lsp.language})`;
}

/**
 * Factory that returns a resolver scoped to a given `cwd`. The extension
 * should pass a factory that caches resolvers per cwd so we don't re-read
 * `pi-base.json` on every read.
 */
export type ReadLspResolverFactory = (cwd: string) => LspDiscoveryResolver;

export function registerReadTool(
  pi: ExtensionAPI,
  options: {
    onSuccessfulRead?: (absolutePath: string, lines?: string[]) => void;
    createBuiltInReadTool?: ReadFactory;
    createResolver?: ReadLspResolverFactory;
    getCollapsedResultLines?: CollapsedResultLinesResolver;
  } = {},
) {
  const tool = {
    name: "read",
    label: "Read",
    description: loadToolDescription("read"),
    promptSnippet: loadToolPromptSnippet("read"),
    parameters: readSchema,
    renderCall(args: any, _theme: any, context: any) {
      return renderCallText(formatReadCall(args, _theme), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, _theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("read", RESULT_COLLAPSED_LINES, context, options.getCollapsedResultLines);
      return renderRawResult(result, { ...renderOptions, collapsedLines }, _theme, context);
    },
    async execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx: any = {}) {
      try {
        await ensureHashInit();
        throwIfAborted(signal);
        const rawPath = String(params.path ?? "").replace(/^@/, "");
        if (!rawPath) throw new Error("path is required.");
        const cwd = ctx.cwd ?? process.cwd();
        const absolutePath = resolveToCwd(rawPath, cwd);
        const st = await throwIfAbortedAfter(stat(absolutePath), signal);

        if (st.isDirectory()) {
          const entries = await throwIfAbortedAfter(readdir(absolutePath, { withFileTypes: true }), signal);
          const names = entries
            .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
            .sort((a, b) => a.localeCompare(b));
          return { content: [{ type: "text" as const, text: [`path: ${rawPath}`, "kind: directory", "", ...names].join("\n") }] };
        }

        if (IMAGE_EXTENSIONS.has(extname(rawPath).toLowerCase())) {
          const builtIn = (options.createBuiltInReadTool ?? createReadTool)(cwd);
          const result = await builtIn.execute(toolCallId, { ...params, path: rawPath }, signal, onUpdate);
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
        // Split on `\n` and keep every element, including the implicit
        // empty element produced by a trailing newline. This is the
        // raw file structure — `read` is a fact-display tool, not an
        // editor that hides structural details. An agent (or human)
        // seeing `2:def|` learns that the file ends with a newline;
        // dropping that information would hide a fact.
        const lines = normalizeToLF(text).split("\n");
        const resolverBaseDir = st.isDirectory() ? absolutePath : dirname(absolutePath);
        const lsp: LspSupportInfo = options.createResolver
          ? options.createResolver(resolverBaseDir).supportsLsp(absolutePath)
          : { supported: false };
        const width = String(lines.length).length;
        const start = Math.min(offset, lines.length + 1);
        const end = Math.min(lines.length, start + limit - 1);
        const body: string[] = [];
        let upstreamTextTruncated = false;
        for (let line = start; line <= end; line++) {
          throwIfAborted(signal);
          const rawLine = lines[line - 1] ?? "";
          const formatted = formatLine(rawLine);
          if (formatted.truncated) upstreamTextTruncated = true;
          body.push(formatHashlineDisplay(line, rawLine, width, formatted.display));
        }
        const hasMore = end < lines.length;
        const header = [
          `path: ${rawPath}`,
          "kind: file",
          "mediaType: text",
          `offset: ${offset}`,
          `limit: ${limit}`,
          `totalLines: ${lines.length}`,
          `hasMore: ${hasMore}`,
          ...(hasMore ? [`nextOffset: ${end + 1}`] : []),
          formatLspStatus(lsp),
        ];
        options.onSuccessfulRead?.(absolutePath, lines);
        return {
          content: [{ type: "text" as const, text: [...header, "", ...body].join("\n") }],
          ...(upstreamTextTruncated ? { details: { upstreamTextTruncated: true } } : {}),
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  };
  pi.registerTool(tool as any);
  return tool;
}
