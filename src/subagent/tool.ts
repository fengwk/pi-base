import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderCallText, renderRawResult, styleAccent, styleMuted, styleToolTitle } from "../render.js";
import { subagentSchema } from "../schemas/subagent.js";
import { loadToolDescription, loadToolPromptSnippet } from "../tool-prompt.js";
import { executeSubagent } from "./runner.js";
import type { SubagentToolDetails } from "./types.js";

export function formatSubagentCall(args: any, theme: any): string {
  const mode = typeof args?.session_id === "string" && args.session_id.trim().length > 0
    ? `resume ${styleAccent(theme, args.session_id)}`
    : "new session";
  const prompt = String(args?.prompt ?? "");
  return [
    `${styleToolTitle(theme, "subagent")} ${styleAccent(theme, String(args?.name ?? "<missing-name>"))}`,
    `${styleMuted(theme, "mode:")} ${mode}`,
    "",
    styleMuted(theme, "prompt preview"),
    prompt,
  ].join("\n");
}

export function formatSubagentResultSummary(details: SubagentToolDetails, theme: any): string {
  const lines = [
    `${styleToolTitle(theme, "subagent result")} ${styleAccent(theme, details.name)}`,
    `${styleMuted(theme, "status:")} ${details.status}`,
    `${styleMuted(theme, "mode:")} ${details.mode}`,
    ...(details.sessionId ? [`${styleMuted(theme, "session_id:")} ${details.sessionId}`] : []),
    "",
    styleMuted(theme, "tail"),
    ...details.tailLines,
  ];
  return lines.join("\n");
}

export function registerSubagentTool(
  pi: ExtensionAPI,
  options: {
    executor?: typeof executeSubagent;
  } = {},
) {
  const executor = options.executor ?? executeSubagent;
  const tool = {
    name: "subagent",
    label: "subagent",
    description: loadToolDescription("subagent"),
    promptSnippet: loadToolPromptSnippet("subagent"),
    parameters: subagentSchema,
    renderCall(args: any, theme: any, context: any) {
      return renderCallText(formatSubagentCall(args, theme), context.lastComponent);
    },
    renderResult(result: AgentToolResult<SubagentToolDetails>, renderOptions: any, theme: any, context: any) {
      if (renderOptions?.expanded) {
        return renderRawResult(result, renderOptions, theme, context);
      }
      const details = result?.details as SubagentToolDetails | undefined;
      if (!details) return renderRawResult(result, renderOptions, theme, context);
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      component.setText(formatSubagentResultSummary(details, theme));
      return component;
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx: any = {}) {
      try {
        return await executor({
          pi,
          ctx,
          name: String(params?.name ?? ""),
          prompt: String(params?.prompt ?? ""),
          sessionId: typeof params?.session_id === "string" && params.session_id.trim().length > 0 ? params.session_id.trim() : undefined,
          signal,
          onUpdate,
        });
      } catch (error) {
        const message = (error as Error).message;
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: {
            mode: params?.session_id ? "resume" : "new",
            name: String(params?.name ?? ""),
            status: "failed" as const,
            tailLines: [message],
            summary: message,
            error: message,
          },
          isError: true,
        };
      }
    },
  };
  pi.registerTool(tool as any);
  return tool;
}
