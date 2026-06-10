import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderCallText, renderRawResult } from "../render.js";
import { buildExpandedTaskResultText, buildTaskErrorResult, formatTaskCallText, formatTaskResultSummaryText, parseTaskParams } from "./task-format.js";
import type { SubagentRunDetails } from "./types.js";
import type { executeSubagent } from "./runner.js";

export function createTaskTool(
  pi: ExtensionAPI,
  executor: typeof executeSubagent,
  metadata: Pick<{ description: string; promptSnippet: string; parameters: unknown }, "description" | "promptSnippet" | "parameters">,
) {
  return {
    name: "task",
    label: "task",
    description: metadata.description,
    promptSnippet: metadata.promptSnippet,
    parameters: metadata.parameters,
    renderCall(args: any, theme: any, context: any) {
      return renderCallText(formatTaskCallText(parseTaskParams(args), theme), context.lastComponent);
    },
    renderResult(result: AgentToolResult<SubagentRunDetails>, renderOptions: any, theme: any, context: any) {
      const details = result?.details as SubagentRunDetails | undefined;
      if (renderOptions?.expanded) {
        return details
          ? renderRawResult({ content: [{ type: "text", text: buildExpandedTaskResultText(details) }] }, renderOptions, theme, context)
          : renderRawResult(result, renderOptions, theme, context);
      }
      if (!details) return renderRawResult(result, renderOptions, theme, context);
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      component.setText(formatTaskResultSummaryText(details, theme));
      return component;
    },
    async execute(_toolCallId: string, rawParams: any, signal?: AbortSignal, onUpdate?: any, ctx: any = {}) {
      const params = parseTaskParams(rawParams);
      if (!params.subagent) return buildTaskErrorResult(params, "task requires a non-empty `subagent` argument.");
      if (params.prompt.trim().length === 0) return buildTaskErrorResult(params, "task requires a non-empty `prompt` argument.");
      try {
        return await executor({
          pi,
          ctx,
          name: params.subagent,
          prompt: params.prompt,
          sessionId: params.sessionId,
          signal,
          onUpdate,
        });
      } catch (error) {
        return buildTaskErrorResult(params, (error as Error).message);
      }
    },
  };
}
