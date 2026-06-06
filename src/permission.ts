import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, relative } from "node:path";
import { loadPiBaseSettings, type LoadedPiBaseSettings, type PermissionAction, type PermissionRuleEntry } from "./config.js";
import { resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import { PI_BASE_INLINE_STATUS_KEYS, PI_BASE_PERMISSION_STATUS_KEY, syncYoloFooter } from "./yolo-footer.js";

const STATUS_KEY = PI_BASE_PERMISSION_STATUS_KEY;
const YOLO_ENTRY_TYPE = "pi-base-permission-yolo";
const ALLOW_LABEL = "Yes";
const DENY_LABEL = "No";
const PROMPT_ARGUMENTS_MAX_CHARS = 120;

interface PermissionState {
  yolo: boolean;
}

interface TargetDescriptor {
  candidates: string[];
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeMatchValue(value: string): string {
  return normalizeSlashes(value.trim());
}

function expandHomePattern(pattern: string): string {
  const home = normalizeSlashes(process.env.HOME ?? process.env.USERPROFILE ?? "");
  if (!home) return pattern;
  if (pattern === "~") return home;
  if (pattern.startsWith("~/")) return home + pattern.slice(1);
  if (pattern === "$HOME") return home;
  if (pattern.startsWith("$HOME/")) return home + pattern.slice(5);
  return pattern;
}

function escapeRegexCharacter(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function wildcardToRegExp(pattern: string): RegExp {
  let body = "";
  for (const char of pattern) {
    if (char === "*") {
      body += ".*";
      continue;
    }
    if (char === "?") {
      body += ".";
      continue;
    }
    body += escapeRegexCharacter(char);
  }
  return new RegExp(`^${body}$`);
}

function wildcardMatches(pattern: string, candidate: string): boolean {
  const normalizedPattern = normalizeMatchValue(expandHomePattern(pattern));
  const normalizedCandidate = normalizeMatchValue(candidate);
  return wildcardToRegExp(normalizedPattern).test(normalizedCandidate);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const normalized = normalizeSlashes(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function normalizeRelativePath(value: string): string {
  const normalized = normalizeSlashes(value);
  return normalized === "" ? "." : normalized;
}

function projectRootFromSettingsPath(settingsPath: string): string {
  return dirname(dirname(settingsPath));
}

function buildPathTargetDescriptor(rawPath: string, cwd: string, loaded: LoadedPiBaseSettings): TargetDescriptor {
  const normalizedRawPath = normalizeSlashes(stripAtPrefix(rawPath));
  const absolutePath = resolveToCwd(rawPath, cwd);
  const normalizedAbsolutePath = normalizeSlashes(absolutePath);
  const relativeToCwd = normalizeRelativePath(relative(cwd, absolutePath));
  const projectRoot = projectRootFromSettingsPath(loaded.projectPath);
  const relativeToProject = normalizeRelativePath(relative(projectRoot, absolutePath));
  const inProjectRoot = relativeToProject !== ".." && !relativeToProject.startsWith("../");
  return {
    candidates: uniqueStrings([
      normalizedRawPath,
      relativeToCwd,
      inProjectRoot ? relativeToProject : undefined,
      normalizedAbsolutePath,
    ]),
  };
}

function tokenizeCommandSegment(segment: string): string[] {
  return segment.match(/\S+/g) ?? [];
}

function buildBashSegmentCandidates(segment: string): string[] {
  const trimmed = segment.trim();
  if (!trimmed) return [];
  const tokens = tokenizeCommandSegment(trimmed);
  const prefixes: string[] = [];
  for (let length = 1; length <= tokens.length; length++) {
    prefixes.push(tokens.slice(0, length).join(" "));
  }
  return uniqueStrings([
    trimmed,
    ...prefixes,
    ...prefixes.map((prefix) => `${prefix} *`),
  ]);
}

function splitBashCommand(command: string): string[] {
  return command
    .split(/&&|\|\||\||;|\n/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function buildCommandTargetDescriptor(commandValue: string): TargetDescriptor {
  const command = commandValue.trim() || "<missing-command>";
  return {
    candidates: [command],
  };
}

function buildGenericTargetDescriptor(_toolName: string): TargetDescriptor {
  return {
    candidates: ["*"],
  };
}

function describeTarget(toolName: string, input: Record<string, unknown>, cwd: string, loaded: LoadedPiBaseSettings): TargetDescriptor {
  if (typeof input.path === "string" && input.path.trim().length > 0) {
    if (typeof input.workdir === "string" && input.workdir.trim().length > 0) {
      const { cwd: targetCwd } = resolveToolWorkdir(input.workdir, cwd);
      return buildPathTargetDescriptor(input.path, targetCwd, loaded);
    }
    return { candidates: [normalizeSlashes(stripAtPrefix(input.path))] };
  }
  if (typeof input.command === "string") {
    return buildCommandTargetDescriptor(input.command);
  }
  return buildGenericTargetDescriptor(toolName);
}

function evaluateRules(candidates: string[], ...rulesets: Array<PermissionRuleEntry[] | undefined>): PermissionAction {
  let action: PermissionAction = "allow";
  for (const ruleset of rulesets) {
    if (!ruleset) continue;
    for (const rule of ruleset) {
      if (candidates.some((candidate) => wildcardMatches(rule.pattern, candidate))) {
        action = rule.action;
      }
    }
  }
  return action;
}

function evaluateBashRules(command: string, ...rulesets: Array<PermissionRuleEntry[] | undefined>): PermissionAction {
  const segments = splitBashCommand(command);
  if (segments.length === 0) return evaluateRules([command], ...rulesets);
  let action: PermissionAction = "allow";
  for (const segment of segments) {
    const next = evaluateRules(buildBashSegmentCandidates(segment), ...rulesets);
    if (next === "deny") return "deny";
    if (next === "ask") action = "ask";
  }
  return action;
}

function restoreStateFromEntries(state: PermissionState, entries: unknown[]): boolean {
  let restored = false;
  state.yolo = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: string; customType?: string; data?: Record<string, unknown> };
    if (record.type !== "custom") continue;
    if (record.customType === YOLO_ENTRY_TYPE && typeof record.data?.enabled === "boolean") {
      state.yolo = record.data.enabled;
      restored = true;
    }
  }
  return restored;
}

function updateYoloStatus(ctx: ExtensionContext, state: PermissionState): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, state.yolo ? ctx.ui.theme.fg("warning", "YOLO") : undefined);
}

function syncYoloStatusFooter(ctx: ExtensionContext, pi: Pick<ExtensionAPI, "getThinkingLevel">, state: PermissionState): void {
  updateYoloStatus(ctx, state);
  if (state.yolo) syncYoloFooter(ctx, pi, { statusKey: STATUS_KEY, extraStatusKeys: PI_BASE_INLINE_STATUS_KEYS });
}

function stringifyPromptArguments(input: unknown): string {
  try {
    const serialized = JSON.stringify(input, (_key, value) => {
      if (typeof value === "bigint") return `${value.toString()}n`;
      if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
      return value;
    });
    if (serialized !== undefined) return serialized;
  } catch {
    // Fall through to a compact fallback for unusual tool input objects.
  }
  return String(input);
}

function toSingleLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

function truncateSingleLine(value: string, maxChars = PROMPT_ARGUMENTS_MAX_CHARS): string {
  const singleLine = toSingleLine(value);
  if (singleLine.length <= maxChars) return singleLine;
  const sliceLength = Math.max(0, maxChars - 3);
  return `${singleLine.slice(0, sliceLength)}...`;
}

function getPromptWorkdir(input: unknown): string {
  if (input && typeof input === "object") {
    const workdir = (input as Record<string, unknown>).workdir;
    if (workdir !== undefined && workdir !== null) return truncateSingleLine(String(workdir));
  }
  return "<missing-workdir>";
}

function buildPrompt(toolName: string, input: unknown): string {
  const argumentsPreview = truncateSingleLine(stringifyPromptArguments(input)) || "{}";
  return [
    "Permission request",
    "",
    `Tool: ${toolName}`,
    `Workdir: ${getPromptWorkdir(input)}`,
    `Arguments: ${argumentsPreview}`,
    "",
    "Allow this tool call?",
  ].join("\n");
}

function buildSettingsHint(loaded: LoadedPiBaseSettings): string {
  return `Update ${loaded.projectPath} or ${loaded.globalPath} under \`permission\` to change this behavior.`;
}

function buildDeniedReason(toolName: string, loaded: LoadedPiBaseSettings): string {
  return `Permission denied for ${toolName}. ${buildSettingsHint(loaded)}`;
}

function buildAskWithoutUiReason(toolName: string, loaded: LoadedPiBaseSettings): string {
  return `Permission approval is required for ${toolName}, but no interactive UI is available. ${buildSettingsHint(loaded)}`;
}

function buildRejectedReason(toolName: string): string {
  return `Permission denied by user for ${toolName}.`;
}


function configuredYoloEnabled(loaded: LoadedPiBaseSettings): boolean {
  return loaded.settings.yolo === true;
}

export function registerPermissionGuard(
  pi: Pick<ExtensionAPI, "appendEntry" | "on" | "registerCommand" | "getThinkingLevel">,
  options: { loadSettings?: (cwd: string) => LoadedPiBaseSettings } = {},
): void {
  const state: PermissionState = {
    yolo: false,
  };
  const loadSettings = options.loadSettings ?? loadPiBaseSettings;

  pi.registerCommand("yolo", {
    description: "Toggle yolo mode (bypass permission checks)",
    handler: async (args: string, ctx) => {
      if (args.trim().length > 0) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /yolo", "warning");
        return;
      }
      state.yolo = !state.yolo;
      pi.appendEntry(YOLO_ENTRY_TYPE, { enabled: state.yolo });
      syncYoloStatusFooter(ctx, pi, state);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadSettings(ctx.cwd);
    const entries = ctx.sessionManager.getEntries();
    const restored = restoreStateFromEntries(state, Array.isArray(entries) ? entries : []);
    if (!restored) state.yolo = configuredYoloEnabled(loaded);
    syncYoloStatusFooter(ctx, pi, state);
  });

  pi.on("tool_call", async (event, ctx) => {
    updateYoloStatus(ctx, state);
    if (state.yolo) return undefined;

    const loaded = loadSettings(ctx.cwd);
    const permission = loaded.settings.permission;
    if (!permission) return undefined;

    const target = describeTarget(event.toolName, event.input, ctx.cwd, loaded);
    const action = event.toolName === "bash" && typeof event.input.command === "string"
      ? evaluateBashRules(event.input.command, permission["*"], permission[event.toolName])
      : evaluateRules(target.candidates, permission["*"], permission[event.toolName]);

    if (action === "allow") return undefined;
    if (action === "deny") {
      return { block: true, reason: buildDeniedReason(event.toolName, loaded) };
    }
    if (!ctx.hasUI) {
      return { block: true, reason: buildAskWithoutUiReason(event.toolName, loaded) };
    }

    const choice = await ctx.ui.select(buildPrompt(event.toolName, event.input), [ALLOW_LABEL, DENY_LABEL]);
    if (choice === ALLOW_LABEL) return undefined;
    ctx.abort();
    return { block: true, reason: buildRejectedReason(event.toolName) };
  });
}
