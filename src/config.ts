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

export type YoloMode = "enable" | "disable";

export interface PiBaseSettings {
  lsp?: LspDiscoveryConfig;
  permission?: PermissionConfig;
  render?: RenderConfig;
  yolo?: YoloMode;
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
  if (input.searchPaths !== undefined) output.searchPaths = requireStringArray(input.searchPaths, "lsp.searchPaths");
  if (input.servers !== undefined) output.servers = sanitizeLspServersRecord(input.servers, "lsp.servers");
  return Object.keys(output).length > 0 ? output : undefined;
}

function isPermissionAction(value: unknown): value is PermissionAction {
  return value === "allow" || value === "ask" || value === "deny";
}

function isYoloMode(value: unknown): value is YoloMode {
  return value === "enable" || value === "disable";
}

function sanitizeYoloMode(value: unknown): YoloMode {
  if (!isYoloMode(value)) throw new Error("yolo must be \"enable\" or \"disable\".");
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
  if (yolo) output.yolo = yolo;
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

function shouldNormalizeCommandPath(value: string): boolean {
  if (isHomeShortcutPath(value)) return true;
  if (value.startsWith("$")) return false;
  return (value.includes("/") || value.includes("\\")) && !isAbsolute(value);
}

function normalizePathLikeEntry(value: string, baseDir: string): string {
  const expanded = expandHomePath(value);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}
function normalizeLspConfigPaths(config: LspDiscoveryConfig | undefined, baseDir: string): LspDiscoveryConfig | undefined {
  if (!config) return undefined;
  return {
    ...(config.searchPaths ? { searchPaths: config.searchPaths.map((entry) => normalizePathLikeEntry(entry, baseDir)) } : {}),
    ...(config.servers
      ? {
          servers: Object.fromEntries(Object.entries(config.servers).map(([id, entry]) => {
            const [command0, ...rest] = entry.command;
            const normalizedCommand = command0 && shouldNormalizeCommandPath(command0)
              ? [normalizePathLikeEntry(command0, baseDir), ...rest]
              : entry.command;
            return [id, { ...entry, command: normalizedCommand }];
          })),
        }
      : {}),
  };
}

function normalizeSettingsPaths(settings: PiBaseSettings, settingsFilePath: string): PiBaseSettings {
  const baseDir = dirname(settingsFilePath);
  return {
    ...(settings.lsp ? { lsp: normalizeLspConfigPaths(settings.lsp, baseDir) } : {}),
    ...(settings.permission ? { permission: settings.permission } : {}),
    ...(settings.render ? { render: settings.render } : {}),
    ...(settings.yolo ? { yolo: settings.yolo } : {}),
  };
}

function readSettingsFile(filePath: string): PiBaseSettings {
  if (!existsSync(filePath)) return {};
  try {
    const settings = sanitizeSettings(JSON.parse(readFileSync(filePath, "utf8")));
    return normalizeSettingsPaths(settings, filePath);
  } catch (error) {
    throw new Error(`Invalid pi-base settings at ${filePath}: ${(error as Error).message}`);
  }
}

function mergeLsp(base: LspDiscoveryConfig | undefined, override: LspDiscoveryConfig | undefined): LspDiscoveryConfig | undefined {
  if (!base && !override) return undefined;
  const searchPaths = override?.searchPaths ?? base?.searchPaths;
  const servers = override?.servers ?? base?.servers;
  if (!searchPaths && !servers) return undefined;
  return {
    ...(searchPaths ? { searchPaths } : {}),
    ...(servers ? { servers } : {}),
  };
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
    },
  };
}
