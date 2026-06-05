import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { resolveToCwd } from "./path-utils.js";
import type { ContextCompressionConfig, ContextCompressionToolConfig } from "./config.js";

type AnchorHygieneToolName = "read" | "write" | "edit";

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
  [key: string]: unknown;
}

interface ToolCompressionOptions {
  retainedUserMessageRounds: number;
  retainedAssistantTurns: number;
}

interface ContextCompressionProjectionOptions {
  systemPrompt?: string;
}

const HASHLINE_RE = /(?:^|\n)(?:[+|]\s*)?\s*\d+#[0-9a-f]{4}\|/;

export const DEFAULT_CONTEXT_COMPRESSION_TOOL_OPTIONS: ToolCompressionOptions = {
  retainedUserMessageRounds: 2,
  retainedAssistantTurns: 4,
};

const FILE_CHANGED_PLACEHOLDER = "[context compression: earlier file output omitted because the file changed later. Re-run read for current content before using LINE#HASH anchors.]";
const OLDER_TOOL_OUTPUT_PLACEHOLDER = "[context compression: older tool output omitted. Re-run the tool if you need those details.]";
export function isContextCompressionPlaceholderText(text: string): boolean {
  return text === FILE_CHANGED_PLACEHOLDER || text === OLDER_TOOL_OUTPUT_PLACEHOLDER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAnchorHygieneToolName(value: unknown): value is AnchorHygieneToolName {
  return value === "read" || value === "write" || value === "edit";
}

function stripAtPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function normalizePath(path: string): string {
  return path.replace(/\\+/g, "/");
}

function canonicalizePath(path: string): string {
  const normalized = normalizePath(path);
  if (!existsSync(normalized)) return normalized;
  try {
    return normalizePath(realpathSync(normalized));
  } catch {
    return normalized;
  }
}

function resolveInputPath(input: unknown, cwd: string): string | undefined {
  if (!isRecord(input) || typeof input.path !== "string" || input.path.trim().length === 0) return undefined;
  return canonicalizePath(resolveToCwd(stripAtPrefix(input.path), cwd));
}

function resolvePromptPath(path: string, cwd: string): string {
  const stripped = stripAtPrefix(path.trim());
  return canonicalizePath(isAbsolute(stripped) ? stripped : resolveToCwd(stripped, cwd));
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text: string } =>
      isRecord(item) && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function hasLiveHashlineAnchors(content: unknown): boolean {
  return HASHLINE_RE.test(extractText(content));
}

function isReadTextFileResult(content: unknown): boolean {
  const text = extractText(content);
  return /(?:^|\n)kind: file(?:\n|$)/.test(text)
    && /(?:^|\n)mediaType: text(?:\n|$)/.test(text)
    && HASHLINE_RE.test(text);
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
  toolName: string,
  config: ContextCompressionConfig | undefined,
): ToolCompressionOptions | undefined {
  if (!config?.tools || !Object.prototype.hasOwnProperty.call(config.tools, toolName)) return undefined;
  const toolConfig: ContextCompressionToolConfig = config.tools[toolName] ?? {};
  if (toolConfig.enable === false) return undefined;
  return {
    retainedUserMessageRounds: toolConfig.retainedUserMessageRounds ?? DEFAULT_CONTEXT_COMPRESSION_TOOL_OPTIONS.retainedUserMessageRounds,
    retainedAssistantTurns: toolConfig.retainedAssistantTurns ?? DEFAULT_CONTEXT_COMPRESSION_TOOL_OPTIONS.retainedAssistantTurns,
  };
}

function buildAgeIndexes(messages: readonly ToolResultMessageLike[]): {
  userRoundAt: number[];
  assistantTurnAt: number[];
  totalUserRounds: number;
  totalAssistantTurns: number;
} {
  const userRoundAt: number[] = [];
  const assistantTurnAt: number[] = [];
  let totalUserRounds = 0;
  let totalAssistantTurns = 0;
  let previousWasUser = false;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "user") {
      if (!previousWasUser) totalUserRounds++;
      previousWasUser = true;
    } else {
      previousWasUser = false;
    }

    if (message?.role === "assistant") totalAssistantTurns++;

    userRoundAt[index] = totalUserRounds;
    assistantTurnAt[index] = totalAssistantTurns;
  }

  return { userRoundAt, assistantTurnAt, totalUserRounds, totalAssistantTurns };
}

function shouldCompressByAge(
  index: number,
  ageIndexes: ReturnType<typeof buildAgeIndexes>,
  options: ToolCompressionOptions,
): boolean {
  if (ageIndexes.totalUserRounds === 0 || ageIndexes.totalAssistantTurns === 0) return false;
  const userRoundsAfter = ageIndexes.totalUserRounds - ageIndexes.userRoundAt[index];
  const assistantTurnsAfter = ageIndexes.totalAssistantTurns - ageIndexes.assistantTurnAt[index];
  return userRoundsAfter >= options.retainedUserMessageRounds
    && assistantTurnsAfter >= options.retainedAssistantTurns;
}

function isFileContextResult(toolName: string, message: ToolResultMessageLike): boolean {
  if (toolName === "read") return isReadTextFileResult(message.content);
  if (toolName === "write" || toolName === "edit") return hasLiveHashlineAnchors(message.content);
  return false;
}

function isSuccessfulMutation(toolName: string, message: ToolResultMessageLike): boolean {
  return (toolName === "write" || toolName === "edit") && message.isError !== true;
}

function placeholderForReason(reason: CompressionReason): string {
  return reason === "file_changed_later" ? FILE_CHANGED_PLACEHOLDER : OLDER_TOOL_OUTPUT_PLACEHOLDER;
}

function maskMessage<T extends ToolResultMessageLike>(message: T, reason: CompressionReason): T {
  return {
    ...message,
    content: [{ type: "text" as const, text: placeholderForReason(reason) }],
  };
}

export function applyContextCompressionToMessages<T extends ToolResultMessageLike>(
  messages: readonly T[],
  cwd: string,
  config?: ContextCompressionConfig,
  options?: ContextCompressionProjectionOptions,
): T[] {
  const toolCalls = buildToolCallIndex(messages);
  const ageIndexes = buildAgeIndexes(messages);
  const skillRoots = buildSkillRoots(cwd, options);
  const dirtyFiles = new Set<string>();
  const anchorHygieneEnabled = isAnchorHygieneEnabled(config);
  let changed = false;
  const next = [...messages] as T[];

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "toolResult") continue;

    const call = resolveToolCall(message, toolCalls);
    if (!call) continue;
    const toolName = call.toolName;
    const path = resolveInputPath(call.input, cwd);
    const skillRead = toolName === "read" && isSkillReadPath(path, skillRoots);

    let reason: CompressionReason | undefined;
    if (anchorHygieneEnabled && path && isAnchorHygieneToolName(toolName) && isFileContextResult(toolName, message) && dirtyFiles.has(path)) {
      reason = "file_changed_later";
    } else if (!skillRead) {
      const compressionOptions = resolveToolCompressionOptions(toolName, config);
      if (compressionOptions && shouldCompressByAge(index, ageIndexes, compressionOptions)) {
        reason = "older_tool_output";
      }
    }

    if (reason) {
      next[index] = maskMessage(message, reason);
      changed = true;
    }

    if (path && isSuccessfulMutation(toolName, message)) {
      dirtyFiles.add(path);
    }
  }

  return changed ? next : (messages as T[]);
}
