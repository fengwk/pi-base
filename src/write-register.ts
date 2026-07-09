import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderCallText, renderStreamingCallText, renderRawResult, resolveCollapsedResultLines, resolveCollapsedResultMaxChars, type CollapsedResultLinesResolver, type CollapsedResultMaxCharsResolver } from "./render.js";
import { writeSchema } from "./schemas/write.js";
import { mapFilePathToPath } from "./tool-arg-aliases.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";
import { executeWrite, formatWriteCall } from "./write-core.js";
import { withPiBaseErrorMarker } from "./tool-error-marker.js";

// `renderCall` renders the tool call (header + content body) for both the
// "in-progress / args complete / expanded" view and the "applied" collapsed view.
// Phases from the render context:
//   - argsComplete === false             -> model is still streaming args
//   - argsComplete && executionStarted=false && isPartial=true  -> toolcall streamed,
//                                              apply not yet started
//   - executionStarted && isPartial=true -> preflight / execute in flight
//                                              (covers permission, yolo fast-path,
//                                              and the actual fs write)
//   - isPartial === false && !expanded   -> tool apply has settled and the user is in
//                                              the collapsed state; this is the
//                                              moment we collapse the call body to
//                                              a preview so the chat stays scannable
//   - isPartial === false && expanded    -> tool apply has settled but the user has
//                                              expanded the tool row; keep the full
//                                              body so the expanded view is honest
function shouldCollapseWriteCall(context: any): boolean {
  if (!context || typeof context !== "object") return false;
  if (context.isPartial !== false) return false;
  if (context.expanded === true) return false;
  return true;
}

function formatWriteCallForContext(args: any, theme: any, context: any): string {
  return formatWriteCall(args, theme, context?.cwd, {
    collapsed: shouldCollapseWriteCall(context),
  });
}

export function registerWriteTool(
  pi: ExtensionAPI,
  options: { onSuccessfulWrite?: (absolutePath: string) => void; getCollapsedResultLines?: CollapsedResultLinesResolver; getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver } = {},
) {
  const tool = {
    name: "write",
    label: "write",
    description: loadToolDescription("write"),
    promptSnippet: loadToolPromptSnippet("write"),
    prepareArguments(args: unknown) {
      return mapFilePathToPath(args);
    },
    parameters: writeSchema,
    renderCall(args: any, theme: any, context: any) {
      // While the model is still streaming args, route through renderStreamingCallText so
      // the rolling window keeps the latest few body lines instead of a full dump. Once
      // args are complete (or the host doesn't tell us), render the static call so the
      // collapse/full branching below can take over.
      if (context?.argsComplete === false) {
        return renderStreamingCallText(formatWriteCallForContext(args, theme, context), theme, context);
      }
      return renderCallText(formatWriteCallForContext(args, theme, context), context?.lastComponent);
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
