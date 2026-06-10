import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SubagentRunDetails } from "./types.js";

export interface ParsedTaskParams {
  subagent: string;
  prompt: string;
  sessionId?: string;
  mode: "new" | "resume";
}

export function parseTaskParams(args: unknown): ParsedTaskParams {
  const input = args as { subagent?: unknown; prompt?: unknown; session_id?: unknown } | undefined;
  const sessionId = typeof input?.session_id === "string" && input.session_id.trim().length > 0
    ? input.session_id.trim()
    : undefined;
  return {
    subagent: typeof input?.subagent === "string" ? input.subagent.trim() : "",
    prompt: typeof input?.prompt === "string" ? input.prompt : String(input?.prompt ?? ""),
    sessionId,
    mode: sessionId ? "resume" : "new",
  };
}

export function buildTaskErrorResult(
  details: Pick<ParsedTaskParams, "subagent" | "mode" | "sessionId">,
  message: string,
): AgentToolResult<SubagentRunDetails> & { isError: true } {
  const errorLine = `Error: ${message}`;
  return {
    content: [{
      type: "text",
      text: [
        `subagent ${details.subagent || "<missing-subagent>"} run failed.`,
        ...(details.sessionId ? [`session_id: \`${details.sessionId}\``] : []),
        "",
        "error:",
        message,
      ].join("\n"),
    }],
      details: {
        ...(details.sessionId ? { sessionId: details.sessionId } : {}),
        mode: details.mode,
        name: details.subagent,
        status: "failed",
        tailLines: [errorLine],
        summary: message,
        transcriptLines: ["Error:", message],
        error: message,
    },
    isError: true,
  };
}

export function formatTaskCallText(args: ParsedTaskParams, theme: any): string {
  const mode = args.sessionId ? `resume ${theme?.fg ? theme.fg("accent", args.sessionId) : args.sessionId}` : "new session";
  const title = theme?.fg ? theme.fg("toolTitle", theme?.bold ? theme.bold("task") : "task") : "task";
  const subagent = theme?.fg ? theme.fg("accent", args.subagent || "<missing-subagent>") : (args.subagent || "<missing-subagent>");
  const muted = (text: string) => theme?.fg ? theme.fg("muted", text) : text;
  return [
    `${title} ${subagent}`,
    `${muted("mode:")} ${mode}`,
    "",
    muted("prompt preview"),
    args.prompt,
  ].join("\n");
}

export function formatTaskResultSummaryText(details: SubagentRunDetails, theme: any): string {
  const stateColor = details.status === "failed" ? "error" : details.status === "running" ? "warning" : "toolTitle";
  const statusColor = details.status === "failed" ? "error" : details.status === "running" ? "warning" : "success";
  const title = theme?.fg ? theme.fg(stateColor, theme?.bold ? theme.bold("task result") : "task result") : "task result";
  const subagent = theme?.fg ? theme.fg("accent", details.name) : details.name;
  const muted = (text: string) => theme?.fg ? theme.fg("muted", text) : text;
  const status = theme?.fg ? theme.fg(statusColor, details.status) : details.status;
  const tailLines = details.tailLines.map((line) => line.startsWith("Error:") && theme?.fg ? theme.fg("error", line) : line);
  return [
    `${title} ${subagent}`,
    `${muted("status:")} ${status}`,
    `${muted("mode:")} ${details.mode}`,
    ...(details.sessionId ? [`${muted("session_id:")} ${details.sessionId}`] : []),
    "",
    muted("tail"),
    ...tailLines,
  ].join("\n");
}

export function buildExpandedTaskResultText(details: SubagentRunDetails): string {
  const lines = [
    "Subagent Session:",
    `name: ${details.name}`,
    `status: ${details.status}`,
    `mode: ${details.mode}`,
    ...(details.sessionId ? [`session_id: ${details.sessionId}`] : []),
    ...(details.error ? [`error: ${details.error}`] : []),
  ];
  if (details.transcriptLines && details.transcriptLines.length > 0) {
    lines.push("", "Transcript:", ...details.transcriptLines);
  } else if (details.tailLines.length > 0) {
    lines.push("", "Recent Activity:", ...details.tailLines);
  }
  return lines.join("\n");
}
