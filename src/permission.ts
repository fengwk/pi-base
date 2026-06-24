import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { analyzeBashSurfaceCommand, buildBashSurfaceCandidates } from "./bash-command-analyzer.js";
import { dirname, relative } from "node:path";
import { type LoadedPiBaseSettings, type PermissionAction, type PermissionRuleEntry } from "./config.js";
import { describeToolWorkdirForDisplay, expandHomePath, normalizeSlashes, resolveToCwd, resolveToolWorkdir, stripAtPrefix } from "./path-utils.js";
import { PI_BASE_INLINE_STATUS_KEYS, PI_BASE_PERMISSION_STATUS_KEY, syncYoloFooter } from "./yolo-footer.js";
import { loadRuntimePiBaseSettings, toggleRuntimeYolo } from "./runtime-settings.js";

import { Patch } from "./hashline/index.js";
const STATUS_KEY = PI_BASE_PERMISSION_STATUS_KEY;
const ALLOW_LABEL = "Yes";
const DENY_LABEL = "No";
const PROMPT_ARGUMENTS_MAX_CHARS = 120;


interface TargetDescriptor {
  candidates: string[];
}


function normalizeMatchValue(value: string): string {
  return normalizeSlashes(value.trim());
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
  const normalizedPattern = normalizeMatchValue(expandHomePath(pattern));
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

function buildHashlinePatchTargetDescriptor(inputText: string, cwd: string, loaded: LoadedPiBaseSettings): TargetDescriptor | undefined {
  try {
    const patch = Patch.parse(inputText, { cwd });
    if (patch.sections.length === 0) return undefined;
    return {
      candidates: uniqueStrings(
        patch.sections.flatMap((section) => buildPathTargetDescriptor(section.path, cwd, loaded).candidates),
      ),
    };
  } catch {
    return undefined;
  }
}

function describeTarget(toolName: string, input: Record<string, unknown>, cwd: string, loaded: LoadedPiBaseSettings): TargetDescriptor {
  if (typeof input.path === "string" && input.path.trim().length > 0) {
    const { cwd: targetCwd } = resolveToolWorkdir(input.workdir, cwd);
    return buildPathTargetDescriptor(input.path, targetCwd, loaded);
  }
  if (toolName === "edit") {
    const inputText = typeof input.input === "string" ? input.input : undefined;
    if (inputText && inputText.trim().length > 0) {
      const { cwd: targetCwd } = resolveToolWorkdir(input.workdir, cwd);
      const target = buildHashlinePatchTargetDescriptor(inputText, targetCwd, loaded);
      if (target) return target;
    }
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
  const analysis = analyzeBashSurfaceCommand(command);
  if (analysis.kind === "unsupported") {
    const staticAction = evaluateRules([command], ...rulesets);
    return staticAction === "deny" ? "deny" : "ask";
  }
  if (analysis.segments.length === 0) return evaluateRules([command], ...rulesets);

  let action: PermissionAction = "allow";
  for (const segment of analysis.segments) {
    const next = evaluateRules(buildBashSurfaceCandidates(segment), ...rulesets);
    if (next === "deny") return "deny";
    if (next === "ask") action = "ask";
  }
  return action;
}


function updateYoloStatus(ctx: ExtensionContext, enabled: boolean): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, enabled ? ctx.ui.theme.fg("warning", "YOLO") : undefined);
}

function syncYoloStatusFooter(ctx: ExtensionContext, pi: Pick<ExtensionAPI, "getThinkingLevel">, enabled: boolean): void {
  updateYoloStatus(ctx, enabled);
  if (enabled) syncYoloFooter(ctx, pi, { statusKey: STATUS_KEY, extraStatusKeys: PI_BASE_INLINE_STATUS_KEYS });
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

function getPromptWorkdir(input: unknown, cwd: string): string {
  const workdir = input && typeof input === "object" ? (input as Record<string, unknown>).workdir : undefined;
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(workdir, cwd);
  return `${truncateSingleLine(rawWorkdir)}${usedDefault ? " (default)" : ""}`;
}

function buildPrompt(toolName: string, input: unknown, cwd: string): string {
  const argumentsPreview = truncateSingleLine(stringifyPromptArguments(input)) || "{}";
  return [
    "Permission request",
    "",
    `Tool: ${toolName}`,
    `Workdir: ${getPromptWorkdir(input, cwd)}`,
    `Arguments: ${argumentsPreview}`,
    "",
    "Allow this tool call?",
  ].join("\n");
}

function buildSettingsHint(loaded: LoadedPiBaseSettings): string {
  return `Update ${loaded.projectPath} or ${loaded.globalPath} under \`permission\`, then run /reload for the change to take effect.`;
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



export function registerPermissionGuard(
  pi: Pick<ExtensionAPI, "on" | "registerCommand" | "getThinkingLevel">,
  options: {
    loadSettings?: (cwd: string) => LoadedPiBaseSettings;
    toggleYolo?: (cwd: string) => boolean;
    onPermissionAsked?: (input: { ctx: ExtensionContext }) => Promise<void>;
    onPermissionRejected?: (input: { ctx: ExtensionContext }) => void;
  } = {},
): void {
  const loadSettings = options.loadSettings ?? loadRuntimePiBaseSettings;
  const toggleYolo = options.toggleYolo ?? toggleRuntimeYolo;
  const onPermissionAsked = options.onPermissionAsked;
  const onPermissionRejected = options.onPermissionRejected;

  pi.registerCommand("yolo", {
    description: "Toggle yolo mode (bypass permission checks)",
    handler: async (args: string, ctx) => {
      if (args.trim().length > 0) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /yolo", "warning");
        return;
      }
      const enabled = toggleYolo(ctx.cwd);
      syncYoloStatusFooter(ctx, pi, enabled);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadSettings(ctx.cwd);
    syncYoloStatusFooter(ctx, pi, loaded.settings.yolo === true);
  });

  pi.on("tool_call", async (event, ctx) => {
    const loaded = loadSettings(ctx.cwd);
    const yoloEnabled = loaded.settings.yolo === true;
    updateYoloStatus(ctx, yoloEnabled);
    if (yoloEnabled) return undefined;

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

    await onPermissionAsked?.({ ctx });
    const choice = await ctx.ui.select(buildPrompt(event.toolName, event.input, ctx.cwd), [ALLOW_LABEL, DENY_LABEL]);
    if (choice === ALLOW_LABEL) return undefined;
    onPermissionRejected?.({ ctx });
    ctx.abort();
    return { block: true, reason: buildRejectedReason(event.toolName) };
  });
}
