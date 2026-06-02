import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { LspDiscoveryConfig, LspServerEntry } from "./lsp/discovery.js";

export interface PiBaseSettings {
  lsp?: LspDiscoveryConfig;
}

export interface LoadedPiBaseSettings {
  settings: PiBaseSettings;
  globalPath: string;
  projectPath: string;
}

function defaultGlobalSettingsPath(): string {
  if (process.env.PI_BASE_GLOBAL_SETTINGS_PATH) return resolve(process.env.PI_BASE_GLOBAL_SETTINGS_PATH);
  return join(homedir(), ".pi", "agent", "pi-base", "settings.json");
}

function defaultProjectSettingsPath(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  // Search upward for the nearest project-scoped pi-base settings file so a
  // call from a repository subdirectory still picks up `<repo>/.pi/pi-base/settings.json`.
  // If no ancestor provides one, fall back to the literal cwd-local location.
  let dir = resolvedCwd;
  let prev = "";
  while (dir !== prev) {
    const candidate = join(dir, ".pi", "pi-base", "settings.json");
    if (existsSync(candidate)) return candidate;
    prev = dir;
    dir = dirname(dir);
  }
  return join(resolvedCwd, ".pi", "pi-base", "settings.json");
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

function sanitizeSettings(value: unknown): PiBaseSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings must be a JSON object.");
  const input = value as Record<string, unknown>;
  const output: PiBaseSettings = {};
  const lsp = input.lsp === undefined ? undefined : sanitizeLspDiscoveryConfig(input.lsp);
  if (lsp) output.lsp = lsp;
  return output;
}

function normalizeLspConfigPaths(config: LspDiscoveryConfig | undefined, baseDir: string): LspDiscoveryConfig | undefined {
  if (!config) return undefined;
  return {
    ...(config.searchPaths ? { searchPaths: config.searchPaths.map((entry) => isAbsolute(entry) ? entry : resolve(baseDir, entry)) } : {}),
    ...(config.servers
      ? {
          servers: Object.fromEntries(Object.entries(config.servers).map(([id, entry]) => {
            const [command0, ...rest] = entry.command;
            const normalizedCommand = command0 && (command0.includes("/") || command0.includes("\\")) && !isAbsolute(command0)
              ? [resolve(baseDir, command0), ...rest]
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
    },
  };
}
