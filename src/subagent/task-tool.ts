import type { Static } from "@sinclair/typebox";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { TASK_TOOL_NAME } from "./constants.js";
import { readDepth } from "./depth.js";
import { subagentRegistry } from "./registry.js";
import { formatRunResult, runSubagent, type RunResult, type SubagentProgressUpdate, type SubagentSessionFactory } from "./runner.js";
import { taskSchema } from "./schema.js";
import { loadToolDescription, loadToolPromptSnippet } from "../tool-prompt.js";

export interface SubagentTaskToolDeps {
  /** Agents the currently-active agent may delegate to (its `subagents` allowlist). */
  getActiveAgentSubagents: () => string[];
  /** Whether an agent name exists in the loaded catalog (after invalid subagent filtering). */
  hasAgent: (name: string) => boolean;
  getMaxConcurrency: (cwd: string) => number;
  getIdleTimeoutMs: (cwd: string) => number | undefined;
  getMaxTurns: (cwd: string) => number | undefined;
  factory: SubagentSessionFactory;
}

const TASK_DESCRIPTION = loadToolDescription(TASK_TOOL_NAME);
const TASK_PROMPT_SNIPPET = loadToolPromptSnippet(TASK_TOOL_NAME);
const LIVE_OUTPUT_LINES = 18;
const MAX_PROGRESS_ENTRIES = 60;
const COLLAPSED_RESULT_LINES = 10;
const pendingSpawnReservations = new Map<string, number>();

interface TaskToolDetails {
  progress?: boolean;
  progressEntries?: string[];
  progressLines?: string[];
  turns?: number;
  toolCalls?: number;
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

function formatTaskCommand(params: { subagent_type?: unknown; description?: unknown; session_id?: unknown }): string {
  const agentType = readString(params.subagent_type) || "<missing-subagent_type>";
  const description = readString(params.description);
  const sessionId = readString(params.session_id);
  const parts = ["task", agentType];
  if (description) parts.push(`--description ${JSON.stringify(description)}`);
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

function formatProgressSummary(turns: number, toolCalls: number): string {
  return `running · turns: ${turns} · tool calls: ${toolCalls}`;
}

function formatVisibleProgress(entries: string[]): string {
  if (entries.length === 0) return "";
  return entries.join("\n\n").split("\n").slice(-LIVE_OUTPUT_LINES).join("\n");
}

function createProgressReporter(onUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined): (update: SubagentProgressUpdate) => void {
  const entries: string[] = [];
  let turns = 0;
  let toolCalls = 0;
  return (update: SubagentProgressUpdate) => {
    if (!onUpdate) return;
    const normalized = update.text.trim();
    const nextTurns = turns + (update.turns ?? 0);
    const nextToolCalls = toolCalls + (update.toolCalls ?? 0);
    const countsChanged = nextTurns !== turns || nextToolCalls !== toolCalls;
    turns = nextTurns;
    toolCalls = nextToolCalls;
    if (normalized && entries.at(-1) !== normalized) {
      entries.push(normalized);
      while (entries.length > MAX_PROGRESS_ENTRIES) entries.shift();
    } else if (!countsChanged) {
      return;
    }
    onUpdate({
      content: [{ type: "text", text: [formatProgressSummary(turns, toolCalls), ...entries].join("\n\n") }],
      details: {
        progress: true,
        progressEntries: [...entries],
        progressLines: [...entries],
        turns,
        toolCalls,
      },
    });
  };
}

function countPendingSpawnReservations(parentSessionId: string): number {
  return pendingSpawnReservations.get(parentSessionId) ?? 0;
}

function tryReserveSpawnSlot(parentSessionId: string, maxConcurrency: number): { active: number; release: () => void } | undefined {
  const running = subagentRegistry.runningChildCount(parentSessionId);
  const pending = countPendingSpawnReservations(parentSessionId);
  const active = running + pending;
  if (active >= maxConcurrency) return undefined;
  pendingSpawnReservations.set(parentSessionId, pending + 1);
  let released = false;
  return {
    active: active + 1,
    release: () => {
      if (released) return;
      released = true;
      const next = (pendingSpawnReservations.get(parentSessionId) ?? 0) - 1;
      if (next > 0) pendingSpawnReservations.set(parentSessionId, next);
      else pendingSpawnReservations.delete(parentSessionId);
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

function renderLiveOutput(result: unknown, theme: any) {
  const details = (result as { details?: TaskToolDetails })?.details;
  const entries = details?.progressEntries
    ?? details?.progressLines
    ?? textContent(result).split("\n\n").map((block) => block.trim()).filter(Boolean);
  const summary = formatProgressSummary(details?.turns ?? 0, details?.toolCalls ?? 0);
  const visible = formatVisibleProgress(entries);
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new Text(paint(theme, "muted", summary), 0, 0));
  const bg = theme?.bg ? (text: string) => theme.bg("toolPendingBg", text) : undefined;
  const box = new Box(1, 1, bg);
  box.addChild(new Text(visible || paint(theme, "muted", "(running...)"), 0, 0));
  container.addChild(box);
  return container;
}

function formatCollapsedReport(report: string, theme: any): string {
  const lines = report.trim().split("\n");
  const visible = lines.slice(0, COLLAPSED_RESULT_LINES);
  const remaining = lines.length - visible.length;
  const body = visible.join("\n") || "(no textual report produced)";
  if (remaining <= 0) return body;
  return `${body}\n${paint(theme, "muted", `... (${remaining} more lines; expand for full report)`)}`;
}

function renderFinalResult(
  result: unknown,
  expanded: boolean | undefined,
  theme: any,
  isError: boolean | undefined,
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
  const body = expanded ? report.trim() || "(no textual report produced)" : formatCollapsedReport(report, theme);
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new Text(header, 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(paint(theme, "muted", "Result"), 0, 0));
  container.addChild(new Text(paint(theme, state === "completed" ? "toolOutput" : "error", body), 0, 0));
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
      if (renderOptions.isPartial) return renderLiveOutput(result, theme);
      return renderFinalResult(result, renderOptions.expanded, theme, context.isError);
    },
    async execute(
      _toolCallId: string,
      params: Static<typeof taskSchema>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      const agentType = readString(params?.subagent_type);
      const description = readString(params?.description);
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
      let releaseSpawnReservation: (() => void) | undefined;
      if (sessionId) {
        const existing = subagentRegistry.get(sessionId);
        if (existing?.status === "running") {
          return errorResult(`subagent session "${sessionId}" is currently running; cannot resume until it finishes.`);
        }
      } else {
        const max = deps.getMaxConcurrency(ctx.cwd);
        const reservation = tryReserveSpawnSlot(parentSessionId, max);
        if (!reservation) {
          const active = subagentRegistry.runningChildCount(parentSessionId) + countPendingSpawnReservations(parentSessionId);
          return errorResult(
            `concurrency limit reached (${active}/${max} subagents running or starting). Wait for one to finish before delegating more.`,
          );
        }
        releaseSpawnReservation = reservation.release;
      }

      const childDepth = readDepth(ctx) + 1;
      const reportProgress = createProgressReporter(onUpdate);
      try {
        const result = await runSubagent(
          ctx,
          {
            agentType,
            description,
            prompt,
            sessionId,
            childDepth,
            idleTimeoutMs: deps.getIdleTimeoutMs(ctx.cwd),
            maxTurns: deps.getMaxTurns(ctx.cwd),
            signal: signal ?? undefined,
            onRegistered: sessionId ? undefined : () => {
              releaseSpawnReservation?.();
              releaseSpawnReservation = undefined;
            },
            onProgress: reportProgress,
          },
          deps.factory,
        );
        return { content: [{ type: "text" as const, text: formatRunResult(result) }], details: { result }, isError: result.state !== "completed" };
      } finally {
        releaseSpawnReservation?.();
      }
    },
  });
}
