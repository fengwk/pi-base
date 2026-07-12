import type { Static } from "@sinclair/typebox";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { TASK_TOOL_NAME } from "./constants.js";
import { readDepth, readRootSessionId } from "./depth.js";
import { subagentRegistry } from "./registry.js";
import { formatRunResult, runSubagent, type RunResult, type SubagentSessionFactory } from "./runner.js";
import { taskSchema } from "./schema.js";
import { loadToolDescription, loadToolPromptSnippet } from "../tool-prompt.js";
import {
  resolveCollapsedResultLines,
  resolveCollapsedResultMaxChars,
  type CollapsedResultLinesResolver,
  type CollapsedResultMaxCharsResolver,
} from "../render.js";

export interface SubagentTaskToolDeps {
  /** Agents the currently-active agent may delegate to (its `subagents` allowlist). */
  getActiveAgentSubagents: () => string[];
  /** Whether an agent name exists in the loaded catalog (after invalid subagent filtering). */
  hasAgent: (name: string) => boolean;
  getMaxConcurrency: (cwd: string) => number;
  getMaxTotalConcurrency: (cwd: string) => number | undefined;
  getIdleTimeoutMs: (cwd: string) => number | undefined;
  getMaxTurns: (cwd: string) => number | undefined;
  getCollapsedResultLines?: CollapsedResultLinesResolver;
  getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver;
  factory: SubagentSessionFactory;
}

const TASK_DESCRIPTION = loadToolDescription(TASK_TOOL_NAME);
const TASK_PROMPT_SNIPPET = loadToolPromptSnippet(TASK_TOOL_NAME);
const TASK_DEFAULT_COLLAPSED_RESULT_LINES = 10;
const pendingSessionReservations = new Map<string, number>();
const pendingRootReservations = new Map<string, number>();
const pendingResumeSessionIds = new Set<string>();

interface TaskToolDetails {
  result?: RunResult;
}

function errorResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined; isError: true } {
  return { content: [{ type: "text", text: `Error: ${text}` }], details: undefined, isError: true };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function displayString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function paint(theme: any, color: string, text: string): string {
  return theme?.fg ? theme.fg(color, text) : text;
}

function title(theme: any, text: string): string {
  return theme?.bold ? paint(theme, "toolTitle", theme.bold(text)) : paint(theme, "toolTitle", text);
}

function formatAvailableAgents(agentNames: string[]): string {
  return agentNames.length > 0 ? agentNames.join(" / ") : "no available agents";
}

function formatTaskCommand(params: { subagent_type?: unknown; session_id?: unknown }): string {
  const agentType = readString(params.subagent_type) || "<missing-subagent_type>";
  const sessionId = readString(params.session_id);
  const parts = ["task", agentType];
  if (sessionId) parts.push(`--resume ${sessionId}`);
  return parts.join(" ");
}

function dimBlock(text: string, theme: any): string {
  const body = text.length > 0 ? text : "<missing-prompt>";
  return body
    .split("\n")
    .map((line) => paint(theme, "dim", line))
    .join("\n");
}

function countPendingSessionReservations(parentSessionId: string): number {
  return pendingSessionReservations.get(parentSessionId) ?? 0;
}

function countPendingRootReservations(rootSessionId: string): number {
  return pendingRootReservations.get(rootSessionId) ?? 0;
}

function tryReserveSessionSlot(
  parentSessionId: string,
  rootSessionId: string,
  maxConcurrency: number,
  maxTotalConcurrency: number | undefined,
): { directActive: number; totalActive: number; release: () => void } | undefined {
  const running = subagentRegistry.runningChildCount(parentSessionId);
  const pending = countPendingSessionReservations(parentSessionId);
  const directActive = running + pending;
  if (directActive >= maxConcurrency) return undefined;

  const totalRunning = subagentRegistry.runningCountForRoot(rootSessionId);
  const totalPending = countPendingRootReservations(rootSessionId);
  const totalActive = totalRunning + totalPending;
  if (maxTotalConcurrency !== undefined && totalActive >= maxTotalConcurrency) return undefined;

  pendingSessionReservations.set(parentSessionId, pending + 1);
  pendingRootReservations.set(rootSessionId, totalPending + 1);
  let released = false;
  return {
    directActive: directActive + 1,
    totalActive: totalActive + 1,
    release: () => {
      if (released) return;
      released = true;
      const nextDirect = (pendingSessionReservations.get(parentSessionId) ?? 0) - 1;
      if (nextDirect > 0) pendingSessionReservations.set(parentSessionId, nextDirect);
      else pendingSessionReservations.delete(parentSessionId);
      const nextTotal = (pendingRootReservations.get(rootSessionId) ?? 0) - 1;
      if (nextTotal > 0) pendingRootReservations.set(rootSessionId, nextTotal);
      else pendingRootReservations.delete(rootSessionId);
    },
  };
}

function isTextContentItem(item: unknown): item is { type?: unknown; text?: unknown } {
  return item !== null && typeof item === "object" && (item as { type?: unknown }).type === "text";
}

function textContent(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextContentItem)
    .map((item) => String(item.text ?? ""))
    .join("\n\n");
}

function extractRunResult(result: unknown): RunResult | undefined {
  const details = (result as { details?: TaskToolDetails })?.details;
  if (details?.result) return details.result;
  const raw = textContent(result);
  const completed = raw.match(/^<task id="([^"]*)" state="completed">\n<task_result>\n([\s\S]*?)\n<\/task_result>\n<\/task>$/);
  if (completed) return { sessionId: completed[1] ?? "", state: "completed", report: completed[2] };
  const failed = raw.match(/^<task id="([^"]*)" state="([^"]*)">\n<task_error>([\s\S]*?)<\/task_error>\n<\/task>$/);
  if (failed) {
    const state = failed[2] === "cancelled" ? "cancelled" : "error";
    return { sessionId: failed[1] ?? "", state, error: failed[3] };
  }
  return undefined;
}

function renderTaskCall(args: Static<typeof taskSchema>, theme: any, lastComponent: unknown) {
  const text = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
  const prompt = displayString(args?.prompt);
  text.setText([
    title(theme, formatTaskCommand(args ?? {})),
    "",
    dimBlock(prompt, theme),
  ].join("\n"));
  return text;
}

function renderTaskReportBody(
  report: string,
  expanded: boolean | undefined,
  theme: any,
  context: { cwd?: string } | undefined,
  deps: Pick<SubagentTaskToolDeps, "getCollapsedResultLines" | "getCollapsedResultMaxChars">,
): string {
  const normalized = report.trim() || "(no textual report produced)";
  if (expanded) return normalized;

  const collapsedLines = resolveCollapsedResultLines(
    TASK_TOOL_NAME,
    TASK_DEFAULT_COLLAPSED_RESULT_LINES,
    context,
    deps.getCollapsedResultLines,
  ) ?? TASK_DEFAULT_COLLAPSED_RESULT_LINES;
  const maxCollapsedChars = resolveCollapsedResultMaxChars(
    TASK_TOOL_NAME,
    undefined,
    context,
    deps.getCollapsedResultMaxChars,
  );

  if (collapsedLines <= 0) return "";

  const charTruncated = typeof maxCollapsedChars === "number" && normalized.length > maxCollapsedChars;
  const charLimitedBody = charTruncated ? normalized.slice(0, maxCollapsedChars) : normalized;
  const lines = charLimitedBody ? charLimitedBody.split("\n") : [];
  const lineTruncated = lines.length > collapsedLines;
  const visibleLineCount = Math.max(0, lineTruncated ? collapsedLines - 1 : lines.length);
  const remaining = Math.max(0, lines.length - visibleLineCount);
  const visibleBody = lines.slice(0, visibleLineCount).join("\n");
  const tailDetails = [
    remaining > 0 ? `${remaining} more lines` : undefined,
    charTruncated ? "output truncated" : undefined,
    remaining > 0 || charTruncated ? "ctrl+o to expand" : undefined,
  ].filter((part): part is string => Boolean(part));
  if (tailDetails.length === 0) return normalized;
  const tail = paint(theme, "muted", `... (${tailDetails.join(", ")})`);
  return visibleBody ? `${visibleBody}\n${tail}` : tail;
}

function renderFinalResult(
  result: unknown,
  expanded: boolean | undefined,
  theme: any,
  isError: boolean | undefined,
  context: { cwd?: string } | undefined,
  deps: Pick<SubagentTaskToolDeps, "getCollapsedResultLines" | "getCollapsedResultMaxChars">,
) {
  const parsed = extractRunResult(result);
  const state = parsed?.state ?? (isError ? "error" : "completed");
  const sessionId = parsed?.sessionId;
  const fallbackError = textContent(result) || state;
  const report = state === "completed"
    ? (parsed?.report ?? "(no textual report produced)")
    : (parsed?.error ?? fallbackError);
  const icon = state === "completed" ? paint(theme, "success", "✓") : paint(theme, "error", "✗");
  const sessionSuffix = sessionId ? paint(theme, "muted", ` (${sessionId})`) : "";
  const header = `${icon} ${title(theme, `task ${state}`)}${sessionSuffix}`;
  const body = renderTaskReportBody(report, expanded, theme, context, deps);
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new Text(header, 0, 0));
  if (body) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(paint(theme, "muted", "Result"), 0, 0));
    container.addChild(new Text(paint(theme, state === "completed" ? "toolOutput" : "error", body), 0, 0));
  }
  return container;
}

/**
 * Register the `task` delegation tool. Validation order: required args -> known-agent check ->
 * subagents allowlist -> resume-not-running guard -> per-session concurrency cap. Then delegate
 * to `runSubagent`.
 */
export function registerSubagentTaskTool(pi: Pick<ExtensionAPI, "registerTool">, deps: SubagentTaskToolDeps): void {
  pi.registerTool({
    name: TASK_TOOL_NAME,
    label: "Task",
    description: TASK_DESCRIPTION,
    promptSnippet: TASK_PROMPT_SNIPPET,
    parameters: taskSchema,
    executionMode: "parallel",
    renderCall(args: Static<typeof taskSchema>, theme, context) {
      return renderTaskCall(args ?? {}, theme, context.lastComponent);
    },
    renderResult(result, renderOptions, theme, context) {
      if (renderOptions.isPartial) return new Text("", 0, 0);
      return renderFinalResult(result, renderOptions.expanded, theme, context.isError, context, deps);
    },
    async execute(
      _toolCallId: string,
      params: Static<typeof taskSchema>,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      const agentType = readString(params?.subagent_type);
      const prompt = readString(params?.prompt);
      const sessionId = readString(params?.session_id) || undefined;

      if (!agentType) return errorResult("`subagent_type` is required.");
      if (!prompt) return errorResult("`prompt` is required.");

      const allowed = deps.getActiveAgentSubagents();
      const availableAgents = formatAvailableAgents(allowed);
      if (!deps.hasAgent(agentType)) {
        return errorResult(`subagent_type "${agentType}" does not exist. Current available agents: ${availableAgents}.`);
      }
      if (!allowed.includes(agentType)) {
        return errorResult(
          `subagent_type "${agentType}" is not allowed. The current agent may delegate to: ${availableAgents}.`,
        );
      }

      const parentSessionId = ctx.sessionManager.getSessionId();
      const rootSessionId = readRootSessionId(ctx) || parentSessionId;
      let releaseSessionReservation: (() => void) | undefined;
      let releaseResumeReservation: (() => void) | undefined;
      if (sessionId) {
        const existing = subagentRegistry.get(sessionId);
        if (existing?.status === "running") {
          return errorResult(`subagent session "${sessionId}" is currently running; cannot resume until it finishes.`);
        }
      }
      const childDepth = readDepth(ctx) + 1;
      const max = deps.getMaxConcurrency(ctx.cwd);
      const maxTotal = deps.getMaxTotalConcurrency(ctx.cwd);
      const reservation = tryReserveSessionSlot(parentSessionId, rootSessionId, max, maxTotal);
      if (!reservation) {
        const directActive = subagentRegistry.runningChildCount(parentSessionId) + countPendingSessionReservations(parentSessionId);
        if (directActive >= max) {
          return errorResult(
            `concurrency limit reached (${directActive}/${max} subagents running or starting). Wait for one to finish before delegating more.`,
          );
        }
        const totalActive = subagentRegistry.runningCountForRoot(rootSessionId) + countPendingRootReservations(rootSessionId);
        return errorResult(
          `total concurrency limit reached (${totalActive}/${maxTotal} subagents running or starting in this delegation tree). Wait for one to finish before delegating more.`,
        );
      }
      releaseSessionReservation = reservation.release;
      if (sessionId) {
        if (pendingResumeSessionIds.has(sessionId)) {
          releaseSessionReservation();
          releaseSessionReservation = undefined;
          return errorResult(`subagent session "${sessionId}" is currently running; cannot resume until it finishes.`);
        }
        pendingResumeSessionIds.add(sessionId);
        releaseResumeReservation = () => pendingResumeSessionIds.delete(sessionId);
      }

      try {
        const result = await runSubagent(
          ctx,
          {
            agentType,
            prompt,
            sessionId,
            childDepth,
            idleTimeoutMs: deps.getIdleTimeoutMs(ctx.cwd),
            maxTurns: deps.getMaxTurns(ctx.cwd),
            signal: signal ?? undefined,
            onRegistered: () => {
              releaseSessionReservation?.();
              releaseSessionReservation = undefined;
            },
          },
          deps.factory,
        );
        return { content: [{ type: "text" as const, text: formatRunResult(result) }], details: { result }, isError: result.state !== "completed" };
      } finally {
        releaseSessionReservation?.();
        releaseResumeReservation?.();
      }
    },
  });
}
