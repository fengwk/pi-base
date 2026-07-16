import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { analyzeBashSurfaceCommand, buildBashSurfaceCandidates } from "./bash-command-analyzer.js";
import { dirname, relative } from "node:path";
import { type LoadedPiBaseSettings, type PermissionAction, type PermissionConfig, type PermissionRuleEntry } from "./config.js";
import { describeToolWorkdirForDisplay, expandHomePath, normalizeSlashes, resolveToCwd, resolveToolWorkdir, stripAtPrefix } from "./path-utils.js";
import { PI_BASE_PERMISSION_STATUS_KEY } from "./yolo-footer.js";
import { loadRuntimePiBaseSettings, toggleRuntimeYolo } from "./runtime-settings.js";
import { askSubagentPermissionHost } from "./subagent/permission-host.js";
import { getApplyPatchIntents, parseApplyPatch, type ApplyPatchIntent } from "./apply-patch-core.js";
import { applyPatchOperationLabel } from "./apply-patch-display.js";

const STATUS_KEY = PI_BASE_PERMISSION_STATUS_KEY;
const ALLOW_LABEL = "Yes";
const DENY_LABEL = "No";
const PERMISSION_PROMPT_MAX_CHARS = 80;


interface TargetDescriptor {
  candidates: string[];
}

interface ApplyPatchPermissionTarget {
  intent: ApplyPatchIntent;
  descriptor: TargetDescriptor;
}

interface PermissionEvaluation {
  action: PermissionAction;
  applyPatchTargets?: ApplyPatchIntent[];
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

function describeTarget(toolName: string, input: Record<string, unknown>, cwd: string, loaded: LoadedPiBaseSettings): TargetDescriptor {
  if (typeof input.path === "string" && input.path.trim().length > 0) {
    const { cwd: targetCwd } = resolveToolWorkdir(input.workdir, cwd);
    return buildPathTargetDescriptor(input.path, targetCwd, loaded);
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

function aggregatePermissionActions(actions: readonly PermissionAction[]): PermissionAction {
  if (actions.includes("deny")) return "deny";
  if (actions.includes("ask")) return "ask";
  return "allow";
}

function getToolPermissionRules(permission: PermissionConfig, toolName: string): PermissionRuleEntry[] | undefined {
  return Object.prototype.hasOwnProperty.call(permission, toolName) ? permission[toolName] : undefined;
}

function inheritedApplyPatchToolName(intent: ApplyPatchIntent): "edit" | "write" {
  return intent.operation === "update" ? "edit" : "write";
}

function evaluateApplyPatchPermission(
  input: Record<string, unknown>,
  cwd: string,
  loaded: LoadedPiBaseSettings,
): PermissionEvaluation {
  const permission = loaded.settings.permission;
  if (!permission || typeof input.patchText !== "string") {
    return { action: evaluateRules(["*"], permission?.["*"], permission?.apply_patch) };
  }

  try {
    const { cwd: targetCwd } = resolveToolWorkdir(input.workdir, cwd);
    const applyPatch = parseApplyPatch(input.patchText);
    const intents = getApplyPatchIntents(applyPatch);
    const targets: ApplyPatchPermissionTarget[] = intents.map((intent) => ({
      intent,
      descriptor: buildPathTargetDescriptor(intent.path, targetCwd, loaded),
    }));
    const actions = targets.map(({ intent, descriptor }) => evaluateRules(
      descriptor.candidates,
      permission["*"],
      permission[inheritedApplyPatchToolName(intent)],
      permission.apply_patch,
    ));
    return { action: aggregatePermissionActions(actions), applyPatchTargets: intents };
  } catch {
    // Parsing and workdir validation belong to the tool. Permission falls back to
    // generic apply_patch rules without attempting to infer malformed targets.
    return { action: evaluateRules(["*"], permission["*"], permission.apply_patch) };
  }
}

function updateYoloStatus(ctx: ExtensionContext, enabled: boolean): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, enabled ? ctx.ui.theme.fg("warning", "YOLO") : undefined);
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

export function truncatePermissionLine(value: string, maxChars = PERMISSION_PROMPT_MAX_CHARS): string {
  const singleLine = toSingleLine(value);
  if (singleLine.length <= maxChars) return singleLine;
  const sliceLength = Math.max(0, maxChars - 3);
  return `${singleLine.slice(0, sliceLength)}...`;
}

function getPromptWorkdirSuffix(input: unknown, cwd: string): string {
  const workdir = input && typeof input === "object" ? (input as Record<string, unknown>).workdir : undefined;
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(workdir, cwd);
  return usedDefault ? "" : ` in ${rawWorkdir}`;
}

function formatApplyPatchPromptTargets(targets: readonly ApplyPatchIntent[]): string {
  return targets.map((target) => {
    const operation = applyPatchOperationLabel(target.operation);
    const destination = target.moveTo === undefined ? "" : ` -> ${target.moveTo}`;
    return `${operation} ${target.path}${destination}`;
  }).join(", ");
}

function summarizePromptInput(input: unknown, applyPatchTargets?: readonly ApplyPatchIntent[]): string {
  if (applyPatchTargets && applyPatchTargets.length > 0) return formatApplyPatchPromptTargets(applyPatchTargets);
  if (!input || typeof input !== "object") return stringifyPromptArguments(input);
  const record = input as Record<string, unknown>;
  if (typeof record.command === "string") return record.command;
  if (typeof record.path === "string") return record.path;

  const summaryEntries = Object.entries(record).filter(([key]) => ![
    "workdir",
    "content",
    "old_string",
    "new_string",
    "patchText",
  ].includes(key));
  return summaryEntries.length > 0 ? stringifyPromptArguments(Object.fromEntries(summaryEntries)) : "";
}

function buildPrompt(
  toolName: string,
  input: unknown,
  cwd: string,
  applyPatchTargets?: readonly ApplyPatchIntent[],
): string {
  const summary = summarizePromptInput(input, applyPatchTargets);
  const detail = summary ? ` ${summary}` : "";
  return truncatePermissionLine(`Permission request: ${toolName}${detail}${getPromptWorkdirSuffix(input, cwd)}`);
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
  pi: Pick<ExtensionAPI, "on" | "registerCommand">,
  options: {
    loadSettings?: (cwd: string) => LoadedPiBaseSettings;
    toggleYolo?: (cwd: string) => boolean;
    /** Must match mutation call renderers so yolo bypass and compact previews use one runtime state. */
    isYoloEnabled?: (cwd: string) => boolean;
    onPermissionAsked?: (input: { ctx: ExtensionContext }) => Promise<void>;
    onPermissionRejected?: (input: { ctx: ExtensionContext }) => void;
    /** Resolve the delegating agent/depth/root-session of a headless subagent session, for the relayed prompt label. */
    resolveSubagentInfo?: (ctx: ExtensionContext) => { agentType: string; depth: number; rootSessionId: string } | undefined;
  } = {},
): void {
  const loadSettings = options.loadSettings ?? loadRuntimePiBaseSettings;
  const toggleYolo = options.toggleYolo ?? toggleRuntimeYolo;
  const isYoloEnabled = options.isYoloEnabled ?? ((cwd: string) => loadSettings(cwd).settings.yolo === true);
  const onPermissionAsked = options.onPermissionAsked;
  const onPermissionRejected = options.onPermissionRejected;
  const resolveSubagentInfo = options.resolveSubagentInfo;

  pi.registerCommand("yolo", {
    description: "Toggle yolo mode (bypass permission checks)",
    handler: async (args: string, ctx) => {
      if (args.trim().length > 0) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /yolo", "warning");
        return;
      }
      const enabled = toggleYolo(ctx.cwd);
      updateYoloStatus(ctx, enabled);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    updateYoloStatus(ctx, isYoloEnabled(ctx.cwd));
  });

  pi.on("tool_call", async (event, ctx) => {
    const loaded = loadSettings(ctx.cwd);
    const yoloEnabled = isYoloEnabled(ctx.cwd);
    updateYoloStatus(ctx, yoloEnabled);
    if (yoloEnabled) return undefined;

    const permission = loaded.settings.permission;
    if (!permission) return undefined;

    let evaluation: PermissionEvaluation;
    if (event.toolName === "apply_patch") {
      evaluation = evaluateApplyPatchPermission(event.input, ctx.cwd, loaded);
    } else {
      const target = describeTarget(event.toolName, event.input, ctx.cwd, loaded);
      const globalRules = getToolPermissionRules(permission, "*");
      const toolRules = getToolPermissionRules(permission, event.toolName);
      evaluation = {
        action: event.toolName === "bash" && typeof event.input.command === "string"
          ? evaluateBashRules(event.input.command, globalRules, toolRules)
          : evaluateRules(target.candidates, globalRules, toolRules),
      };
    }
    const { action } = evaluation;

    if (action === "allow") return undefined;
    if (action === "deny") {
      return { block: true, reason: buildDeniedReason(event.toolName, loaded) };
    }
    if (!ctx.hasUI) {
      // Only genuine subagent sessions (identified by resolveSubagentInfo) relay to the root
      // UI-host; any other headless session (e.g. print/CI top-level) blocks as before.
      const info = resolveSubagentInfo?.(ctx);
      if (info) {
        const decision = await askSubagentPermissionHost({
          agentType: info.agentType,
          depth: info.depth,
          rootSessionId: info.rootSessionId,
          prompt: buildPrompt(event.toolName, event.input, ctx.cwd, evaluation.applyPatchTargets),
          signal: (event as { signal?: AbortSignal }).signal,
        });
        if (decision !== null) {
          if (decision) return undefined;
          onPermissionRejected?.({ ctx });
          return { block: true, reason: buildRejectedReason(event.toolName) };
        }
      }
      return { block: true, reason: buildAskWithoutUiReason(event.toolName, loaded) };
    }

    await onPermissionAsked?.({ ctx });
    const choice = await ctx.ui.select(
      buildPrompt(event.toolName, event.input, ctx.cwd, evaluation.applyPatchTargets),
      [ALLOW_LABEL, DENY_LABEL],
    );
    if (choice === ALLOW_LABEL) return undefined;
    onPermissionRejected?.({ ctx });
    return { block: true, reason: buildRejectedReason(event.toolName) };
  });
}
