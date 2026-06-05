import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { LspDiscoveryConfig, LspServerEntry } from "./lsp/discovery.js";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRuleEntry {
  pattern: string;
  action: PermissionAction;
}

export type PermissionConfig = Record<string, PermissionRuleEntry[]>;

export type CollapsedToolResultLinesConfig = number | Record<string, number>;

export interface RenderConfig {
  collapsedToolResultLines?: CollapsedToolResultLinesConfig;
}


export interface ContextCompressionToolConfig {
  enable?: boolean;
  retainedUserMessageRounds?: number;
  retainedAssistantTurns?: number;
}

export interface ContextCompressionConfig {
  anchorHygiene?: boolean;
  tools?: Record<string, ContextCompressionToolConfig>;
}

export type YoloMode = boolean;

export interface PiBaseSettings {
  lsp?: LspDiscoveryConfig;
  permission?: PermissionConfig;
  render?: RenderConfig;
  yolo?: YoloMode;
  contextCompression?: ContextCompressionConfig;
}

export interface LoadedPiBaseSettings {
  settings: PiBaseSettings;
  globalPath: string;
  projectPath: string;
}

function defaultGlobalSettingsPath(): string {
  if (process.env.PI_BASE_GLOBAL_SETTINGS_PATH) return resolve(process.env.PI_BASE_GLOBAL_SETTINGS_PATH);
  return join(homedir(), ".pi", "agent", "pi-base.json");
}

function defaultProjectSettingsPath(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  let dir = resolvedCwd;
  let previous = "";
  while (dir !== previous) {
    const candidate = join(dir, ".pi", "pi-base.json");
    if (existsSync(candidate)) return candidate;
    previous = dir;
    dir = dirname(dir);
  }
  return join(resolvedCwd, ".pi", "pi-base.json");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!isStringArray(value)) throw new Error(`${path} must be an array of strings.`);
  return value;
}

function sanitizeLspServerEntry(value: unknown, path: string): LspServerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  const input = value as Record<string, unknown>;
  const output: LspServerEntry = {
    command: requireStringArray(input.command, `${path}.command`),
    extensions: requireStringArray(input.extensions, `${path}.extensions`),
  };
  if (input.rootMarkers !== undefined) output.rootMarkers = requireStringArray(input.rootMarkers, `${path}.rootMarkers`);
  if (input.firstMatchMarkers !== undefined) output.firstMatchMarkers = requireStringArray(input.firstMatchMarkers, `${path}.firstMatchMarkers`);
  if (input.requestTimeoutMs !== undefined) {
    if (typeof input.requestTimeoutMs !== "number" || !Number.isFinite(input.requestTimeoutMs) || input.requestTimeoutMs <= 0) {
      throw new Error(`${path}.requestTimeoutMs must be a positive finite number.`);
    }
    output.requestTimeoutMs = input.requestTimeoutMs;
  }
  return output;
}

function sanitizeLspServersRecord(value: unknown, path: string): Record<string, LspServerEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object keyed by server id.`);
  const output: Record<string, LspServerEntry> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    output[id] = sanitizeLspServerEntry(entry, `${path}.${id}`);
  }
  return output;
}

function sanitizeLspDiscoveryConfig(value: unknown): LspDiscoveryConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lsp must be an object.");
  const input = value as Record<string, unknown>;
  const output: LspDiscoveryConfig = {};
  if (input.servers !== undefined) output.servers = sanitizeLspServersRecord(input.servers, "lsp.servers");
  return Object.keys(output).length > 0 ? output : undefined;
}

function isPermissionAction(value: unknown): value is PermissionAction {
  return value === "allow" || value === "ask" || value === "deny";
}

function sanitizeYoloMode(value: unknown): YoloMode {
  if (typeof value !== "boolean") throw new Error("yolo must be a boolean.");
  return value;
}

function sanitizePermissionRule(value: unknown, path: string): PermissionRuleEntry[] {
  if (isPermissionAction(value)) {
    return [{ pattern: "*", action: value }];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be \"allow\", \"ask\", or \"deny\", or an object keyed by pattern.`);
  }
  const entries: PermissionRuleEntry[] = [];
  for (const [pattern, action] of Object.entries(value as Record<string, unknown>)) {
    if (!isPermissionAction(action)) {
      throw new Error(`${path}.${pattern} must be \"allow\", \"ask\", or \"deny\".`);
    }
    entries.push({ pattern, action });
  }
  return entries;
}

function sanitizePermissionConfig(value: unknown): PermissionConfig | undefined {
  if (isPermissionAction(value)) {
    return { "*": [{ pattern: "*", action: value }] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("permission must be \"allow\", \"ask\", or \"deny\", or an object keyed by tool name.");
  }
  const output: PermissionConfig = {};
  for (const [toolName, rule] of Object.entries(value as Record<string, unknown>)) {
    output[toolName] = sanitizePermissionRule(rule, `permission.${toolName}`);
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeCollapsedToolResultLinesConfig(value: unknown, path: string): CollapsedToolResultLinesConfig {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${path} must be a non-negative integer.`);
    }
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a non-negative integer or an object keyed by tool name.`);
  }
  const output: Record<string, number> = {};
  for (const [toolName, lineCount] of Object.entries(value as Record<string, unknown>)) {
    if (!Number.isInteger(lineCount) || Number(lineCount) < 0) {
      throw new Error(`${path}.${toolName} must be a non-negative integer.`);
    }
    output[toolName] = Number(lineCount);
  }
  return output;
}

function cloneCollapsedToolResultLinesConfig(value: CollapsedToolResultLinesConfig | undefined): CollapsedToolResultLinesConfig | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? value : { ...value };
}

function mergeCollapsedToolResultLinesConfig(
  base: CollapsedToolResultLinesConfig | undefined,
  override: CollapsedToolResultLinesConfig | undefined,
): CollapsedToolResultLinesConfig | undefined {
  if (override === undefined) return cloneCollapsedToolResultLinesConfig(base);
  if (base === undefined) return cloneCollapsedToolResultLinesConfig(override);
  if (typeof override === "number") return override;
  const baseMap = typeof base === "number" ? { "*": base } : { ...base };
  return { ...baseMap, ...override };
}

function sanitizeRenderConfig(value: unknown): RenderConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("render must be an object.");
  }
  const input = value as Record<string, unknown>;
  const output: RenderConfig = {};
  if (input.collapsedToolResultLines !== undefined) {
    output.collapsedToolResultLines = sanitizeCollapsedToolResultLinesConfig(input.collapsedToolResultLines, "render.collapsedToolResultLines");
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizePositiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${path} must be a positive integer.`);
  }
  return Number(value);
}

function sanitizeOptionalBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  return value;
}

function sanitizeContextCompressionToolConfig(value: unknown, path: string): ContextCompressionToolConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const input = value as Record<string, unknown>;
  const output: ContextCompressionToolConfig = {};
  if (input.enable !== undefined) output.enable = sanitizeOptionalBoolean(input.enable, `${path}.enable`);
  if (input.retainedUserMessageRounds !== undefined) {
    output.retainedUserMessageRounds = sanitizePositiveInteger(input.retainedUserMessageRounds, `${path}.retainedUserMessageRounds`);
  }
  if (input.retainedAssistantTurns !== undefined) {
    output.retainedAssistantTurns = sanitizePositiveInteger(input.retainedAssistantTurns, `${path}.retainedAssistantTurns`);
  }
  return output;
}

function sanitizeContextCompressionToolsConfig(value: unknown): Record<string, ContextCompressionToolConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("contextCompression.tools must be an object keyed by tool name.");
  }
  const output: Record<string, ContextCompressionToolConfig> = {};
  for (const [toolName, toolConfig] of Object.entries(value as Record<string, unknown>)) {
    if (!toolName.trim()) throw new Error("contextCompression.tools contains an empty tool name.");
    output[toolName] = sanitizeContextCompressionToolConfig(toolConfig, `contextCompression.tools.${toolName}`);
  }
  return output;
}
function sanitizeContextCompressionConfig(value: unknown): ContextCompressionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("contextCompression must be an object.");
  }
  const input = value as Record<string, unknown>;
  const output: ContextCompressionConfig = {};
  if (input.anchorHygiene !== undefined) output.anchorHygiene = sanitizeOptionalBoolean(input.anchorHygiene, "contextCompression.anchorHygiene");
  if (input.tools !== undefined) output.tools = sanitizeContextCompressionToolsConfig(input.tools);
  return output;
}


function sanitizeSettings(value: unknown): PiBaseSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings must be a JSON object.");
  const input = value as Record<string, unknown>;
  const output: PiBaseSettings = {};
  const lsp = input.lsp === undefined ? undefined : sanitizeLspDiscoveryConfig(input.lsp);
  if (lsp) output.lsp = lsp;
  const permission = input.permission === undefined ? undefined : sanitizePermissionConfig(input.permission);
  if (permission) output.permission = permission;
  const render = input.render === undefined ? undefined : sanitizeRenderConfig(input.render);
  if (render) output.render = render;
  const yolo = input.yolo === undefined ? undefined : sanitizeYoloMode(input.yolo);
  if (yolo !== undefined) output.yolo = yolo;
  const contextCompression = input.contextCompression === undefined ? undefined : sanitizeContextCompressionConfig(input.contextCompression);
  if (contextCompression !== undefined) output.contextCompression = contextCompression;
  return output;
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  if (value === "$HOME") return homedir();
  if (value.startsWith("$HOME/") || value.startsWith("$HOME\\")) {
    return join(homedir(), value.slice(6));
  }
  if (value === "${HOME}") return homedir();
  if (value.startsWith("${HOME}/") || value.startsWith("${HOME}\\")) {
    return join(homedir(), value.slice(8));
  }
  return value;
}

function isHomeShortcutPath(value: string): boolean {
  return value === "~"
    || value.startsWith("~/")
    || value.startsWith("~\\")
    || value === "$HOME"
    || value.startsWith("$HOME/")
    || value.startsWith("$HOME\\")
    || value === "${HOME}"
    || value.startsWith("${HOME}/")
    || value.startsWith("${HOME}\\");
}

function normalizeCommandExecutable(value: string, path: string): string {
  const expanded = expandHomePath(value);
  if (isHomeShortcutPath(value)) return expanded;
  if (value.includes("/") || value.includes("\\")) {
    if (!isAbsolute(expanded)) {
      throw new Error(`${path}.command[0] must be a command on PATH or an absolute executable path. ~/..., $HOME/..., and \${HOME}/... are supported.`);
    }
    return expanded;
  }
  return value;
}

function normalizeLspConfigPaths(config: LspDiscoveryConfig | undefined): LspDiscoveryConfig | undefined {
  if (!config?.servers) return config;
  return {
    servers: Object.fromEntries(Object.entries(config.servers).map(([id, entry]) => {
      const [command0, ...rest] = entry.command;
      const normalizedCommand = command0
        ? [normalizeCommandExecutable(command0, `lsp.servers.${id}`), ...rest]
        : entry.command;
      return [id, { ...entry, command: normalizedCommand }];
    })),
  };
}

function normalizeSettingsPaths(settings: PiBaseSettings): PiBaseSettings {
  return {
    ...(settings.lsp ? { lsp: normalizeLspConfigPaths(settings.lsp) } : {}),
    ...(settings.permission ? { permission: settings.permission } : {}),
    ...(settings.render ? { render: settings.render } : {}),
    ...(settings.yolo !== undefined ? { yolo: settings.yolo } : {}),
    ...(settings.contextCompression ? { contextCompression: settings.contextCompression } : {}),
  };
}

function readSettingsFile(filePath: string): PiBaseSettings {
  if (!existsSync(filePath)) return {};
  try {
    const settings = sanitizeSettings(JSON.parse(readFileSync(filePath, "utf8")));
    return normalizeSettingsPaths(settings);
  } catch (error) {
    throw new Error(`Invalid pi-base settings at ${filePath}: ${(error as Error).message}`);
  }
}

function mergeLsp(base: LspDiscoveryConfig | undefined, override: LspDiscoveryConfig | undefined): LspDiscoveryConfig | undefined {
  if (!base && !override) return undefined;
  const servers = override?.servers ?? base?.servers;
  if (!servers) return undefined;
  return { servers };
}

function mergePermission(base: PermissionConfig | undefined, override: PermissionConfig | undefined): PermissionConfig | undefined {
  if (!base && !override) return undefined;
  const output: PermissionConfig = {};
  for (const [toolName, rules] of Object.entries(base ?? {})) {
    output[toolName] = [...rules];
  }
  for (const [toolName, rules] of Object.entries(override ?? {})) {
    output[toolName] = [...(output[toolName] ?? []), ...rules];
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function mergeRender(base: RenderConfig | undefined, override: RenderConfig | undefined): RenderConfig | undefined {
  if (!base && !override) return undefined;
  const collapsedToolResultLines = mergeCollapsedToolResultLinesConfig(base?.collapsedToolResultLines, override?.collapsedToolResultLines);
  if (collapsedToolResultLines === undefined) return undefined;
  return { collapsedToolResultLines };
}

function mergeYolo(base: YoloMode | undefined, override: YoloMode | undefined): YoloMode | undefined {
  return override ?? base;
}


function mergeContextCompressionToolConfig(
  base: ContextCompressionToolConfig | undefined,
  override: ContextCompressionToolConfig | undefined,
): ContextCompressionToolConfig | undefined {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

function mergeContextCompressionTools(
  base: Record<string, ContextCompressionToolConfig> | undefined,
  override: Record<string, ContextCompressionToolConfig> | undefined,
): Record<string, ContextCompressionToolConfig> | undefined {
  if (!base && !override) return undefined;
  const output: Record<string, ContextCompressionToolConfig> = {};
  for (const toolName of new Set([...Object.keys(base ?? {}), ...Object.keys(override ?? {})])) {
    const merged = mergeContextCompressionToolConfig(base?.[toolName], override?.[toolName]);
    if (merged) output[toolName] = merged;
  }
  return output;
}

function mergeContextCompression(
  base: ContextCompressionConfig | undefined,
  override: ContextCompressionConfig | undefined,
): ContextCompressionConfig | undefined {
  if (!base && !override) return undefined;
  const tools = mergeContextCompressionTools(base?.tools, override?.tools);
  const output: ContextCompressionConfig = {
    ...(base?.anchorHygiene !== undefined || override?.anchorHygiene !== undefined ? { anchorHygiene: override?.anchorHygiene ?? base?.anchorHygiene } : {}),
    ...(tools ? { tools } : {}),
  };
  return Object.keys(output).length > 0 ? output : undefined;
}

export function loadPiBaseSettings(cwd: string = process.cwd()): LoadedPiBaseSettings {
  const globalPath = defaultGlobalSettingsPath();
  const projectPath = defaultProjectSettingsPath(cwd);
  const globalSettings = readSettingsFile(globalPath);
  const projectSettings = readSettingsFile(projectPath);
  return {
    globalPath,
    projectPath,
    settings: {
      lsp: mergeLsp(globalSettings.lsp, projectSettings.lsp),
      permission: mergePermission(globalSettings.permission, projectSettings.permission),
      render: mergeRender(globalSettings.render, projectSettings.render),
      yolo: mergeYolo(globalSettings.yolo, projectSettings.yolo),
      contextCompression: mergeContextCompression(globalSettings.contextCompression, projectSettings.contextCompression),
    },
  };
}
