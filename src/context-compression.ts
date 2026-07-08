import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { normalizeSlashes, resolveToCwd, stripAtPrefix } from "./path-utils.js";
import type { ContextCompressionConfig } from "./config.js";

type AnchorHygieneToolName = "read" | "edit";

type CompressionReason = "file_changed_later" | "older_tool_output";

interface ToolCallInfo {
  toolName: string;
  input: unknown;
}

interface ToolResultMessageLike {
  role?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  content?: unknown;
  details?: unknown;
  isError?: unknown;
}

interface ToolCompressionOptions {
  retainedUserMessageRounds: number;
  retainedAssistantTurns: number;
}

interface ResolvedToolCompressionOptions extends ToolCompressionOptions {
  toolNames: ReadonlySet<string>;
}

interface ContextCompressionProjectionOptions {
  systemPrompt?: string;
}
interface UserWindow {
  startMessageIndex: number;
  assistantTurns: number;
}

export const DEFAULT_CONTEXT_COMPRESSION_TOOL_OPTIONS: ToolCompressionOptions = {
  retainedUserMessageRounds: 2,
  retainedAssistantTurns: 4,
};

const GENERIC_TOOL_OUTPUT_PLACEHOLDER = "[context compression: older tool output omitted. Re-run the tool if you need those details.]";
const WRITE_EDIT_OUTPUT_PLACEHOLDER = "[context compression: older tool output omitted. If you need those details, re-check the current state or retrieve the relevant context again.]";
const BASH_OUTPUT_PLACEHOLDER = "[context compression: older tool output omitted. If you need those details, re-check the current state, or re-run the command only if it is safe to do so.]";
const CONTEXT_COMPRESSION_PLACEHOLDERS = new Set([GENERIC_TOOL_OUTPUT_PLACEHOLDER, WRITE_EDIT_OUTPUT_PLACEHOLDER, BASH_OUTPUT_PLACEHOLDER]);
export function isContextCompressionPlaceholderText(text: string): boolean {
  return CONTEXT_COMPRESSION_PLACEHOLDERS.has(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAnchorHygieneToolName(value: unknown): value is AnchorHygieneToolName {
  return value === "read" || value === "edit";
}


function canonicalizePath(path: string): string {
  const normalized = normalizeSlashes(path);
  if (!existsSync(normalized)) return normalized;
  try {
    return normalizeSlashes(realpathSync(normalized));
  } catch {
    return normalized;
  }
}

function resolveInputBaseCwd(workdir: unknown, cwd: string): string {
  // Mirror resolveToolWorkdir so a tool call's path resolves to the same absolute
  // location the tool itself used; tolerate invalid workdir instead of throwing here.
  if (typeof workdir !== "string") return cwd;
  const rawWorkdir = stripAtPrefix(workdir);
  if (rawWorkdir.trim().length === 0) return cwd;
  return resolveToCwd(rawWorkdir, cwd);
}

function resolveInputPaths(input: unknown, cwd: string): string[] {
  if (!isRecord(input)) return [];
  if (typeof input.path === "string" && input.path.trim().length > 0) {
    const baseCwd = resolveInputBaseCwd(input.workdir, cwd);
    return [canonicalizePath(resolveToCwd(stripAtPrefix(input.path), baseCwd))];
  }
  return [];
}

function resolvePromptPath(path: string, cwd: string): string {
  const stripped = stripAtPrefix(path.trim());
  return canonicalizePath(isAbsolute(stripped) ? stripped : resolveToCwd(stripped, cwd));
}

function buildToolCallIndex(messages: readonly ToolResultMessageLike[]): Map<string, ToolCallInfo> {
  const index = new Map<string, ToolCallInfo>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
      index.set(block.id, { toolName: block.name, input: block.arguments });
    }
  }
  return index;
}

function resolveToolCall(message: ToolResultMessageLike, toolCalls: Map<string, ToolCallInfo>): ToolCallInfo | undefined {
  const fromAssistant = typeof message.toolCallId === "string" ? toolCalls.get(message.toolCallId) : undefined;
  if (fromAssistant) return fromAssistant;
  if (typeof message.toolName !== "string") return undefined;
  return { toolName: message.toolName, input: undefined };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractAvailableSkillLocations(systemPrompt: string | undefined): string[] {
  if (!systemPrompt) return [];
  const block = systemPrompt.match(/<available_skills>([\s\S]*?)<\/available_skills>/)?.[1];
  if (!block) return [];
  return [...block.matchAll(/<location>([\s\S]*?)<\/location>/g)]
    .map((match) => decodeXmlEntities(match[1] ?? "").trim())
    .filter(Boolean);
}

function buildSkillRoots(cwd: string, options: ContextCompressionProjectionOptions | undefined): Set<string> {
  const roots = new Set<string>();
  const locations = extractAvailableSkillLocations(options?.systemPrompt);
  for (const location of locations) {
    const skillFile = resolvePromptPath(location, cwd);
    roots.add(skillFile);
    roots.add(canonicalizePath(dirname(skillFile)));
  }
  return roots;
}

function isUnderDirectory(path: string, directory: string): boolean {
  if (path === directory) return true;
  const rel = relative(directory, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isSkillReadPath(path: string | undefined, skillRoots: ReadonlySet<string>): boolean {
  if (!path || skillRoots.size === 0) return false;
  for (const root of skillRoots) {
    if (path === root || isUnderDirectory(path, root)) return true;
  }
  return false;
}

function isAnchorHygieneEnabled(config: ContextCompressionConfig | undefined): boolean {
  return config?.anchorHygiene === true;
}

function resolveToolCompressionOptions(
  config: ContextCompressionConfig | undefined,
): ResolvedToolCompressionOptions | undefined {
  if (!config?.tools || config.tools.length === 0) return undefined;
  return {
    toolNames: new Set(config.tools),
    retainedUserMessageRounds: config.retainedUserMessageRounds ?? DEFAULT_CONTEXT_COMPRESSION_TOOL_OPTIONS.retainedUserMessageRounds,
    retainedAssistantTurns: config.retainedAssistantTurns ?? DEFAULT_CONTEXT_COMPRESSION_TOOL_OPTIONS.retainedAssistantTurns,
  };
}


function buildUserWindows(messages: readonly ToolResultMessageLike[]): UserWindow[] {
  const windows: UserWindow[] = [];
  let currentStartMessageIndex = -1;
  let currentAssistantTurns = 0;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "user") {
      if (currentStartMessageIndex !== -1) {
        windows.push({ startMessageIndex: currentStartMessageIndex, assistantTurns: currentAssistantTurns });
      }
      currentStartMessageIndex = index;
      currentAssistantTurns = 0;
      continue;
    }
    if (message?.role === "assistant" && currentStartMessageIndex !== -1) currentAssistantTurns++;
  }

  if (currentStartMessageIndex !== -1) {
    windows.push({ startMessageIndex: currentStartMessageIndex, assistantTurns: currentAssistantTurns });
  }
  return windows;
}

function buildRetainedRoundsFromWindow(
  windows: readonly UserWindow[],
  retainedAssistantTurns: number,
): number[] {
  const nextRoundStartWindow = new Array<number>(windows.length).fill(-1);
  let endWindow = 0;
  let accumulatedAssistantTurns = 0;

  for (let startWindow = 0; startWindow < windows.length; startWindow++) {
    while (endWindow < windows.length && accumulatedAssistantTurns < retainedAssistantTurns) {
      accumulatedAssistantTurns += windows[endWindow]?.assistantTurns ?? 0;
      endWindow++;
    }
    if (accumulatedAssistantTurns >= retainedAssistantTurns) nextRoundStartWindow[startWindow] = endWindow;
    accumulatedAssistantTurns -= windows[startWindow]?.assistantTurns ?? 0;
  }

  const retainedRoundsFromWindow = new Array<number>(windows.length).fill(0);
  for (let startWindow = windows.length - 1; startWindow >= 0; startWindow--) {
    const nextWindow = nextRoundStartWindow[startWindow];
    retainedRoundsFromWindow[startWindow] = nextWindow === -1
      ? 0
      : 1 + (nextWindow < windows.length ? retainedRoundsFromWindow[nextWindow] ?? 0 : 0);
  }
  return retainedRoundsFromWindow;
}

function buildAgeCompressionEligibility(
  messages: readonly ToolResultMessageLike[],
  options: ToolCompressionOptions,
): boolean[] {
  const eligibility = new Array<boolean>(messages.length).fill(false);
  const windows = buildUserWindows(messages);
  if (windows.length === 0) return eligibility;

  const retainedRoundsFromWindow = buildRetainedRoundsFromWindow(windows, options.retainedAssistantTurns);
  const windowIndexByStartMessage = new Array<number>(messages.length).fill(-1);
  for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
    windowIndexByStartMessage[windows[windowIndex]!.startMessageIndex] = windowIndex;
  }

  let nextUserWindow = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (nextUserWindow !== -1 && retainedRoundsFromWindow[nextUserWindow]! >= options.retainedUserMessageRounds) {
      eligibility[index] = true;
    }
    if (messages[index]?.role === "user") nextUserWindow = windowIndexByStartMessage[index] ?? nextUserWindow;
  }

  return eligibility;
}

function isFileContextResult(toolName: string, message: ToolResultMessageLike): boolean {
  // read carries file content; edit carries a success message + diff that references
  // a file version that may no longer be current. Both become stale after a later mutation.
  // write acks are intentionally kept as timeline anchors and never masked here.
  if (toolName === "read" || toolName === "edit") return message.isError !== true;
  return false;
}

function isSuccessfulMutation(toolName: string, message: ToolResultMessageLike): boolean {
  return (toolName === "write" || toolName === "edit") && message.isError !== true;
}

function placeholderForToolName(toolName: string): string {
  if (toolName === "write" || toolName === "edit") return WRITE_EDIT_OUTPUT_PLACEHOLDER;
  if (toolName === "bash") return BASH_OUTPUT_PLACEHOLDER;
  return GENERIC_TOOL_OUTPUT_PLACEHOLDER;
}

function maskMessage<T extends ToolResultMessageLike>(message: T, toolName: string): T {
  return {
    ...message,
    content: [{ type: "text" as const, text: placeholderForToolName(toolName) }],
  };
}

export function shouldApplyContextCompression(
  config: ContextCompressionConfig | undefined,
  providerId: string | undefined,
): boolean {
  if (!config) return false;
  const hasAgeTools = Array.isArray(config.tools) && config.tools.length > 0;
  const hasAnchorHygiene = config.anchorHygiene === true;
  if (!hasAgeTools && !hasAnchorHygiene) return false;
  if (!providerId) return true;
  const disabled = config.disabledProviders;
  if (!disabled?.length) return true;
  const normalized = providerId.trim().toLowerCase();
  return !disabled.some((entry) => entry.trim().toLowerCase() === normalized);
}

export function applyContextCompressionToMessages<T extends ToolResultMessageLike>(
  messages: readonly T[],
  cwd: string,
  config?: ContextCompressionConfig,
  options?: ContextCompressionProjectionOptions,
): T[] {
  if (!shouldApplyContextCompression(config, undefined)) return messages as T[];
  const toolCalls = buildToolCallIndex(messages);
  const toolCompressionOptions = resolveToolCompressionOptions(config);
  const ageCompressionEligibility = toolCompressionOptions ? buildAgeCompressionEligibility(messages, toolCompressionOptions) : undefined;
  const skillRoots = buildSkillRoots(cwd, options);
  const dirtyFiles = new Set<string>();
  const anchorHygieneEnabled = isAnchorHygieneEnabled(config);
  let changed = false;
  const next = [...messages] as T[];

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "toolResult") continue;
    if (message.isError === true) continue;

    const call = resolveToolCall(message, toolCalls);
    if (!call) continue;
    const toolName = call.toolName;
    const paths = resolveInputPaths(call.input, cwd);
    const skillRead = toolName === "read" && paths.some((candidate) => isSkillReadPath(candidate, skillRoots));

    let reason: CompressionReason | undefined;
    if (anchorHygieneEnabled && paths.length > 0 && isAnchorHygieneToolName(toolName) && isFileContextResult(toolName, message) && paths.some((candidate) => dirtyFiles.has(candidate))) {
      reason = "file_changed_later";
    } else if (!skillRead && toolCompressionOptions?.toolNames.has(toolName) && ageCompressionEligibility?.[index]) {
      reason = "older_tool_output";
    }

    if (reason) {
      next[index] = maskMessage(message, toolName);
      changed = true;
    }

    if (isSuccessfulMutation(toolName, message)) {
      for (const candidate of paths) dirtyFiles.add(candidate);
    }
  }

  return changed ? next : (messages as T[]);
}
