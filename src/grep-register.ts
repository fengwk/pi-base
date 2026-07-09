import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderStreamingCallText, renderRawResult, resolveCollapsedResultLines, resolveCollapsedResultMaxChars, type CollapsedResultLinesResolver, type CollapsedResultMaxCharsResolver } from "./render.js";
import { grepSchema } from "./schemas/grep.js";
import { mapFilePathToPath } from "./tool-arg-aliases.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";
import { executeGrep, formatGrepCall, type GrepFactory } from "./grep-core.js";
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
    prepareArguments(args: unknown) {
      return mapFilePathToPath(args);
    },
    parameters: grepSchema,
    renderCall(args: any, theme: any, context: any) {
      const mappedArgs = mapFilePathToPath(args);
      return renderStreamingCallText(formatGrepCall(mappedArgs, theme, context?.cwd), theme, context);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("grep", undefined, context, options.getCollapsedResultLines);
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
