import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderCallText, renderRawResult, resolveCollapsedResultLines, resolveCollapsedResultMaxChars, type CollapsedResultLinesResolver, type CollapsedResultMaxCharsResolver } from "./render.js";
import { grepSchema } from "./schemas/grep.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";
import { executeGrep, formatGrepCall, GREP_COLLAPSED_PREVIEW_LINES, type GrepFactory } from "./grep-core.js";
import { withPiBaseErrorMarker } from "./tool-error-marker.js";

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
    renderCall(args: any, theme: any, context: any) {
      return renderCallText(formatGrepCall(args, theme, context?.cwd), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("grep", GREP_COLLAPSED_PREVIEW_LINES, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("grep", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(result, { ...renderOptions, collapsedLines, maxCollapsedChars }, theme, context);
    },
    async execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx: any = {}) {
      return executeGrep(toolCallId, params, signal, onUpdate, ctx, options.createBuiltInGrepTool);
    },
  };
  const markedTool = withPiBaseErrorMarker(tool);
  pi.registerTool(markedTool as any);
  return markedTool;
}
