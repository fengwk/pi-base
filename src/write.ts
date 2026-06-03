import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureHashInit, formatHashlineDisplay } from "./hashline.js";
import { resolveToCwd } from "./path-utils.js";
import { type CollapsedResultLinesResolver, renderCallText, renderRawResult, resolveCollapsedResultLines, shortenHomePath, styleAccent, styleToolTitle } from "./render.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";
import { writeSchema } from "./schemas/write.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";

const COLLAPSED_PREVIEW_LINES = 10;

function formatHashlineOutput(content: string): string {
  // Show the file as it is: keep the implicit empty line produced by
  // a trailing newline. Anchors and line numbers reflect the raw
  // structure so the agent and the human see the same facts.
  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines.map((line, index) => formatHashlineDisplay(index + 1, line, width)).join("\n");
}

function formatWriteSuccess(rawPath: string, existed: boolean, content: string): string {
  const action = existed ? "Overwrote" : "Created";
  return `${action} ${rawPath}.
Review the written file content below. Lines prefixed with digits carry LINE:HASH anchors for follow-up edits.

${formatHashlineOutput(content)}`;
}

function formatWriteCall(args: any, theme: any): string {
  const path = shortenHomePath(String(args?.path ?? "<missing-path>"));
  const content = String(args?.content ?? "");
  // Raw `split("\n")`: the preview is the file's actual structure
  // (including the implicit trailing empty when present). We do not
  // silently rewrite structure.
  const lines = content.split("\n");
  return `${styleToolTitle(theme, "write")} ${styleAccent(theme, path)}\n\n${lines.join("\n")}`;
}

export function registerWriteTool(
  pi: ExtensionAPI,
  options: { onFileAnchored?: (absolutePath: string, lines?: string[]) => void; onSuccessfulWrite?: (absolutePath: string) => void; getCollapsedResultLines?: CollapsedResultLinesResolver } = {},
) {
  const tool = {
    name: "write",
    label: "write",
    description: loadToolDescription("write"),
    promptSnippet: loadToolPromptSnippet("write"),
    parameters: writeSchema,
    renderCall(args: any, _theme: any, context: any) {
      return renderCallText(formatWriteCall(args, _theme), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, _theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("write", COLLAPSED_PREVIEW_LINES, context, options.getCollapsedResultLines);
      return renderRawResult(result, { ...renderOptions, collapsedLines }, _theme, context);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      try {
        await ensureHashInit();
        throwIfAborted(signal);
        const rawPath = String(params.path ?? "").replace(/^@/, "");
        if (!rawPath) throw new Error("path is required.");
        const content = String(params.content ?? "");
        const absolutePath = resolveToCwd(rawPath, ctx.cwd ?? process.cwd());
        return withFileMutationQueue(absolutePath, async () => {
          throwIfAborted(signal);
          let existed = true;
          try {
            await throwIfAbortedAfter(stat(absolutePath), signal);
          } catch {
            existed = false;
          }
          await throwIfAbortedAfter(mkdir(dirname(absolutePath), { recursive: true }), signal);
          throwIfAborted(signal);
          await throwIfAbortedAfter(writeFile(absolutePath, content, "utf8"), signal);
          options.onFileAnchored?.(absolutePath, content.split("\n"));
          options.onSuccessfulWrite?.(absolutePath);
          return {
            content: [{ type: "text" as const, text: formatWriteSuccess(rawPath, existed, content) }],
          };
        });
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  };
  pi.registerTool(tool as any);
  return tool;
}
