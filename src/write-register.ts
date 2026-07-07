import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderStreamingCallText, renderRawResult, resolveCollapsedResultLines, resolveCollapsedResultMaxChars, type CollapsedResultLinesResolver, type CollapsedResultMaxCharsResolver } from "./render.js";
import { writeSchema } from "./schemas/write.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";
import { executeWrite, formatWriteCall } from "./write-core.js";
import { withPiBaseErrorMarker } from "./tool-error-marker.js";

export function registerWriteTool(
  pi: ExtensionAPI,
  options: { onSuccessfulWrite?: (absolutePath: string) => void; getCollapsedResultLines?: CollapsedResultLinesResolver; getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver } = {},
) {
  const tool = {
    name: "write",
    label: "write",
    description: loadToolDescription("write"),
    promptSnippet: loadToolPromptSnippet("write"),
    parameters: writeSchema,
    renderCall(args: any, theme: any, context: any) {
      return renderStreamingCallText(formatWriteCall(args, theme, context?.cwd), theme, context);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("write", undefined, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("write", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(result, { ...renderOptions, collapsedLines, maxCollapsedChars }, theme, context);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      return executeWrite(params, signal, ctx, options);
    },
  };
  const markedTool = withPiBaseErrorMarker(tool);
  pi.registerTool(markedTool as any);
  return markedTool;
}
