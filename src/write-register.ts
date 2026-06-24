import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderCallText, renderRawResult, resolveCollapsedResultLines, resolveCollapsedResultMaxChars, type CollapsedResultLinesResolver, type CollapsedResultMaxCharsResolver } from "./render.js";
import { writeSchema } from "./schemas/write.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";
import { executeWrite, formatWriteCall, WRITE_COLLAPSED_PREVIEW_LINES } from "./write-core.js";
import type { InMemorySnapshotStore } from "./hashline/index.js";

export function registerWriteTool(
  pi: ExtensionAPI,
  options: { onFileAnchored?: (absolutePath: string, lines?: string[]) => void; onSuccessfulWrite?: (absolutePath: string) => void; getCollapsedResultLines?: CollapsedResultLinesResolver; getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver; snapshots?: InMemorySnapshotStore } = {},
) {
  const tool = {
    name: "write",
    label: "write",
    description: loadToolDescription("write"),
    promptSnippet: loadToolPromptSnippet("write"),
    parameters: writeSchema,
    renderCall(args: any, theme: any, context: any) {
      return renderCallText(formatWriteCall(args, theme, context?.cwd), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("write", WRITE_COLLAPSED_PREVIEW_LINES, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("write", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(result, { ...renderOptions, collapsedLines, maxCollapsedChars }, theme, context);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      return executeWrite(params, signal, ctx, options);
    },
  };
  pi.registerTool(tool as any);
  return tool;
}
