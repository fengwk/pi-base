import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { LspDiscoveryConfig, LspServerEntry, LspWorkspaceDataConfig, LspWorkspaceDataMode } from "./lsp/discovery.js";
import type { LocalMcpServerConfig, McpConfig, McpServerConfig, RemoteMcpServerConfig } from "./mcp/types.js";
import { expandHomePath, isHomeShortcutPath } from "./path-utils.js";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRuleEntry {
  pattern: string;
  action: PermissionAction;
}

export type PermissionConfig = Record<string, PermissionRuleEntry[]>;

export type CollapsedToolResultLinesConfig = number | Record<string, number>;
export type CollapsedToolResultMaxCharsConfig = number | Record<string, number>;

export interface RenderConfig {
  collapsedToolResultLines?: CollapsedToolResultLinesConfig;
  collapsedToolResultMaxChars?: CollapsedToolResultMaxCharsConfig;
}

export interface NotifyConfig {
  permissionAsked?: boolean;
  agentEnd?: boolean;
  /**
   * How long (in milliseconds) a "session.completed" notification is
   * suppressed after the user rejects a permission. Defaults to 5000.
   * Set to 0 to disable the suppression entirely.
   */
  suppressCompletedAfterRejectionMs?: number;
}


export interface ContextCompressionConfig {
  anchorHygiene?: boolean;
  retainedUserMessageRounds?: number;
  retainedAssistantTurns?: number;
  tools?: string[];
  /** When set, context compression applies only to listed provider ids (case-insensitive) unless later excluded by `disabledProviders`. */
  enabledProviders?: string[];
  /** When the active model's provider id is listed here, pi-base skips context compression for that LLM call (messages are left unchanged). Use for providers whose prompt cache breaks when tool results are replaced with placeholders (e.g. some xAI setups). */
  disabledProviders?: string[];
}

export type YoloMode = boolean;

export interface SubagentConfig {
  /** Max delegation depth. Root session is depth 1; the `task` tool is injected only while depth < maxDepth. Default 2. */
  maxDepth?: number;
  /** Max number of subagents a single session may run concurrently. Excess `task` calls are rejected. Default 10. */
  maxConcurrency?: number;
  /** Max number of running subagents allowed across one root session's entire delegation tree. Omit to disable this total cap. */
  maxTotalConcurrency?: number;
  /** Abort a delegated subagent after this many milliseconds without any session activity. Omit or set 0 to disable. */
  idleTimeoutMs?: number;
  /** Default soft-stop budget for delegated subagents. A task call may override it; an unfinished child is asked for a phase report at the budget and every five later tool-driving turns. Error/aborted messages do not count. Defaults to 50. */
  maxTurns?: number;
}

export interface PiBaseSettings {
  lsp?: LspDiscoveryConfig;
  permission?: PermissionConfig;
  render?: RenderConfig;
  notify?: NotifyConfig;
  yolo?: YoloMode;
  mcp?: McpConfig;
  contextCompression?: ContextCompressionConfig;
  subagent?: SubagentConfig;
  /** Fresh sessions start in this named agent when no agent was persisted and no `--agent` flag is provided. */
  defaultAgent?: string;
}

export interface LoadedPiBaseSettings {
  settings: PiBaseSettings;
  globalPath: string;
  projectPath: string;
}

function defaultGlobalSettingsPath(): string {
  if (process.env.PI_BASE_GLOBAL_SETTINGS_PATH) return resolve(expandHomePath(process.env.PI_BASE_GLOBAL_SETTINGS_PATH));
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

function requireNonEmptyStringArray(value: unknown, path: string): string[] {
  const output = requireStringArray(value, path);
  if (output.length === 0) throw new Error(`${path} must contain at least one entry.`);
  return output;
}

function requireStringRecord(value: unknown, path: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object keyed by string.`);
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") throw new Error(`${path}.${key} must be a string.`);
    output[key] = entry;
  }
  return output;
}

function sanitizeLspWorkspaceDataConfig(value: unknown, path: string): LspWorkspaceDataConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  const input = value as Record<string, unknown>;
  const output: LspWorkspaceDataConfig = {};
  if (input.mode !== undefined) {
    const mode = input.mode;
    if (mode !== "stable" && mode !== "process" && mode !== "disabled") {
      throw new Error(`${path}.mode must be "stable", "process", or "disabled".`);
    }
    output.mode = mode as LspWorkspaceDataMode;
  }
  if (input.baseDir !== undefined) {
    if (typeof input.baseDir !== "string" || input.baseDir.trim().length === 0) {
      throw new Error(`${path}.baseDir must be a non-empty string.`);
    }
    output.baseDir = input.baseDir;
  }
  return output;
}

function sanitizeLspServerEntry(value: unknown, path: string): LspServerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  const input = value as Record<string, unknown>;
  const output: LspServerEntry = {
    command: requireNonEmptyStringArray(input.command, `${path}.command`),
    extensions: requireNonEmptyStringArray(input.extensions, `${path}.extensions`),
  };
  if (input.rootMarkers !== undefined) output.rootMarkers = requireStringArray(input.rootMarkers, `${path}.rootMarkers`);
  if (input.firstMatchMarkers !== undefined) output.firstMatchMarkers = requireStringArray(input.firstMatchMarkers, `${path}.firstMatchMarkers`);
  if (input.workspaceData !== undefined) output.workspaceData = sanitizeLspWorkspaceDataConfig(input.workspaceData, `${path}.workspaceData`);
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
function sanitizeCollapsedToolResultMaxCharsConfig(value: unknown, path: string): CollapsedToolResultMaxCharsConfig {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || Number(value) < 0) {
      throw new Error(`${path} must be a non-negative integer.`);
    }
    return Number(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a non-negative integer or an object keyed by tool name.`);
  }
  const output: Record<string, number> = {};
  for (const [toolName, charCount] of Object.entries(value as Record<string, unknown>)) {
    if (!Number.isInteger(charCount) || Number(charCount) < 0) {
      throw new Error(`${path}.${toolName} must be a non-negative integer.`);
    }
    output[toolName] = Number(charCount);
  }
  return output;
}

function cloneCollapsedToolResultMaxCharsConfig(value: CollapsedToolResultMaxCharsConfig | undefined): CollapsedToolResultMaxCharsConfig | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? value : { ...value };
}

function mergeCollapsedToolResultMaxCharsConfig(
  base: CollapsedToolResultMaxCharsConfig | undefined,
  override: CollapsedToolResultMaxCharsConfig | undefined,
): CollapsedToolResultMaxCharsConfig | undefined {
  if (override === undefined) return cloneCollapsedToolResultMaxCharsConfig(base);
  if (base === undefined) return cloneCollapsedToolResultMaxCharsConfig(override);
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
  if (input.collapsedToolResultMaxChars !== undefined) {
    output.collapsedToolResultMaxChars = sanitizeCollapsedToolResultMaxCharsConfig(input.collapsedToolResultMaxChars, "render.collapsedToolResultMaxChars");
  }
  return Object.keys(output).length > 0 ? output : undefined;
}
function sanitizeNotifyConfig(value: unknown): NotifyConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("notify must be an object.");
  }
  const input = value as Record<string, unknown>;
  const output: NotifyConfig = {};
  if (input.permissionAsked !== undefined) output.permissionAsked = sanitizeOptionalBoolean(input.permissionAsked, "notify.permissionAsked");
  if (input.agentEnd !== undefined) output.agentEnd = sanitizeOptionalBoolean(input.agentEnd, "notify.agentEnd");
  if (input.suppressCompletedAfterRejectionMs !== undefined) {
    output.suppressCompletedAfterRejectionMs = sanitizeNonNegativeInteger(
      input.suppressCompletedAfterRejectionMs,
      "notify.suppressCompletedAfterRejectionMs",
    );
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${path} must be a non-negative integer.`);
  }
  return Number(value);
}

function sanitizePositiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${path} must be a positive integer.`);
  }
  return Number(value);
}

function sanitizeNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${path} must be a non-empty string.`);
  return trimmed;
}

function sanitizeSubagentConfig(value: unknown): SubagentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("subagent must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  const output: SubagentConfig = {};
  if (input.maxDepth !== undefined) output.maxDepth = sanitizePositiveInteger(input.maxDepth, "subagent.maxDepth");
  if (input.maxConcurrency !== undefined) output.maxConcurrency = sanitizePositiveInteger(input.maxConcurrency, "subagent.maxConcurrency");
  if (input.maxTotalConcurrency !== undefined) output.maxTotalConcurrency = sanitizePositiveInteger(input.maxTotalConcurrency, "subagent.maxTotalConcurrency");
  if (input.idleTimeoutMs !== undefined) output.idleTimeoutMs = sanitizeNonNegativeInteger(input.idleTimeoutMs, "subagent.idleTimeoutMs");
  if (input.maxTurns !== undefined) output.maxTurns = sanitizePositiveInteger(input.maxTurns, "subagent.maxTurns");
  return output;
}

function sanitizeOptionalBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  return value;
}

function sanitizeContextCompressionToolsConfig(value: unknown): string[] {
  const tools = requireStringArray(value, "contextCompression.tools");
  const output: string[] = [];
  const seen = new Set<string>();
  for (const toolName of tools) {
    const normalizedToolName = toolName.trim();
    if (!normalizedToolName) throw new Error("contextCompression.tools contains an empty tool name.");
    if (seen.has(normalizedToolName)) continue;
    seen.add(normalizedToolName);
    output.push(normalizedToolName);
  }
  return output;
}

function sanitizeContextCompressionProviders(
  value: unknown,
  path: "contextCompression.enabledProviders" | "contextCompression.disabledProviders",
  options: { allowEmpty: boolean },
): string[] {
  const providers = requireStringArray(value, path);
  const normalized = providers.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (!options.allowEmpty && normalized.length === 0) throw new Error(`${path} must contain at least one provider id.`);
  return normalized;
}

function sanitizeContextCompressionConfig(value: unknown): ContextCompressionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("contextCompression must be an object.");
  }
  const input = value as Record<string, unknown>;
  const output: ContextCompressionConfig = {};
  if (input.anchorHygiene !== undefined) output.anchorHygiene = sanitizeOptionalBoolean(input.anchorHygiene, "contextCompression.anchorHygiene");
  if (input.retainedUserMessageRounds !== undefined) {
    output.retainedUserMessageRounds = sanitizePositiveInteger(input.retainedUserMessageRounds, "contextCompression.retainedUserMessageRounds");
  }
  if (input.retainedAssistantTurns !== undefined) {
    output.retainedAssistantTurns = sanitizePositiveInteger(input.retainedAssistantTurns, "contextCompression.retainedAssistantTurns");
  }
  if (input.tools !== undefined) output.tools = sanitizeContextCompressionToolsConfig(input.tools);
  if (input.enabledProviders !== undefined) {
    output.enabledProviders = sanitizeContextCompressionProviders(input.enabledProviders, "contextCompression.enabledProviders", { allowEmpty: true });
  }
  if (input.disabledProviders !== undefined) {
    output.disabledProviders = sanitizeContextCompressionProviders(input.disabledProviders, "contextCompression.disabledProviders", { allowEmpty: false });
  }
  return output;
}
function sanitizeMcpLocalServerConfig(value: unknown, path: string): LocalMcpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  const input = value as Record<string, unknown>;
  if (input.type !== "local") throw new Error(`${path}.type must be "local".`);
  const output: LocalMcpServerConfig = {
    type: "local",
    command: requireNonEmptyStringArray(input.command, `${path}.command`),
  };
  if (input.env !== undefined) output.env = requireStringRecord(input.env, `${path}.env`);
  if (input.cwd !== undefined) {
    if (typeof input.cwd !== "string") throw new Error(`${path}.cwd must be a string.`);
    output.cwd = input.cwd;
  }
  if (input.enabled !== undefined) output.enabled = sanitizeOptionalBoolean(input.enabled, `${path}.enabled`);
  if (input.toolPrefix !== undefined) {
    if (typeof input.toolPrefix !== "string") throw new Error(`${path}.toolPrefix must be a string.`);
    output.toolPrefix = input.toolPrefix;
  }
  if (input.startupTimeoutMs !== undefined) {
    output.startupTimeoutMs = sanitizePositiveInteger(input.startupTimeoutMs, `${path}.startupTimeoutMs`);
  }
  if (input.callTimeoutMs !== undefined) {
    output.callTimeoutMs = sanitizePositiveInteger(input.callTimeoutMs, `${path}.callTimeoutMs`);
  }
  return output;
}

function sanitizeMcpRemoteServerConfig(value: unknown, path: string): RemoteMcpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  const input = value as Record<string, unknown>;
  if (input.type !== "remote") throw new Error(`${path}.type must be "remote".`);
  if (typeof input.url !== "string") throw new Error(`${path}.url must be a string.`);
  if (typeof input.transport !== "string" || (input.transport !== "websocket" && input.transport !== "sse" && input.transport !== "streamable-http")) {
    throw new Error(`${path}.transport must be one of websocket, sse, or streamable-http.`);
  }
  try {
    new URL(input.url);
  } catch {
    throw new Error(`${path}.url must be a valid URL.`);
  }
  const output: RemoteMcpServerConfig = {
    type: "remote",
    transport: input.transport,
    url: input.url,
  };
  if (input.headers !== undefined) output.headers = requireStringRecord(input.headers, `${path}.headers`);
  if (input.enabled !== undefined) output.enabled = sanitizeOptionalBoolean(input.enabled, `${path}.enabled`);
  if (input.toolPrefix !== undefined) {
    if (typeof input.toolPrefix !== "string") throw new Error(`${path}.toolPrefix must be a string.`);
    output.toolPrefix = input.toolPrefix;
  }
  if (input.startupTimeoutMs !== undefined) {
    output.startupTimeoutMs = sanitizePositiveInteger(input.startupTimeoutMs, `${path}.startupTimeoutMs`);
  }
  if (input.callTimeoutMs !== undefined) {
    output.callTimeoutMs = sanitizePositiveInteger(input.callTimeoutMs, `${path}.callTimeoutMs`);
  }
  return output;
}

function sanitizeMcpServerConfig(value: unknown, path: string): McpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  const type = (value as Record<string, unknown>).type;
  if (type === "local") return sanitizeMcpLocalServerConfig(value, path);
  if (type === "remote") return sanitizeMcpRemoteServerConfig(value, path);
  throw new Error(`${path}.type must be either "local" or "remote".`);
}

function sanitizeMcpConfig(value: unknown): McpConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mcp must be an object.");
  const input = value as Record<string, unknown>;
  if (input.servers !== undefined && (typeof input.servers !== "object" || input.servers === null || Array.isArray(input.servers))) {
    throw new Error("mcp.servers must be an object keyed by server name.");
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [serverKey, config] of Object.entries((input.servers ?? {}) as Record<string, unknown>)) {
    if (!serverKey.trim()) throw new Error("mcp.servers contains an empty server name.");
    servers[serverKey] = sanitizeMcpServerConfig(config, `mcp.servers.${serverKey}`);
  }
  const output: McpConfig = { servers };
  if (input.startupTimeoutMs !== undefined) {
    output.startupTimeoutMs = sanitizePositiveInteger(input.startupTimeoutMs, "mcp.startupTimeoutMs");
  }
  if (input.callTimeoutMs !== undefined) {
    output.callTimeoutMs = sanitizePositiveInteger(input.callTimeoutMs, "mcp.callTimeoutMs");
  }
  return output;
}
function sanitizeSettings(value: unknown): PiBaseSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings must be a JSON object.");
  const input = value as Record<string, unknown>;
  return {
    lsp: input.lsp === undefined ? undefined : sanitizeLspDiscoveryConfig(input.lsp),
    permission: input.permission === undefined ? undefined : sanitizePermissionConfig(input.permission),
    render: input.render === undefined ? undefined : sanitizeRenderConfig(input.render),
    notify: input.notify === undefined ? undefined : sanitizeNotifyConfig(input.notify),
    yolo: input.yolo === undefined ? undefined : sanitizeYoloMode(input.yolo),
    mcp: input.mcp === undefined ? undefined : sanitizeMcpConfig(input.mcp),
    contextCompression: input.contextCompression === undefined ? undefined : sanitizeContextCompressionConfig(input.contextCompression),
    subagent: input.subagent === undefined ? undefined : sanitizeSubagentConfig(input.subagent),
    defaultAgent: input.defaultAgent === undefined ? undefined : sanitizeNonEmptyString(input.defaultAgent, "defaultAgent"),
  };
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
      const workspaceData = entry.workspaceData?.baseDir
        ? { ...entry.workspaceData, baseDir: normalizeDirectoryPath(entry.workspaceData.baseDir, `lsp.servers.${id}.workspaceData.baseDir`) }
        : entry.workspaceData;
      return [id, { ...entry, command: normalizedCommand, ...(workspaceData ? { workspaceData } : {}) }];
    })),
  };
}

function normalizeDirectoryPath(value: string, path: string): string {
  const expanded = expandHomePath(value);
  if (!isAbsolute(expanded)) {
    throw new Error(`${path} must be an absolute path. ~/..., $HOME/..., and \${HOME}/... are supported.`);
  }
  return expanded;
}

function normalizeMcpConfigPaths(config: McpConfig | undefined): McpConfig | undefined {
  if (!config?.servers) return config;
  return {
    ...config,
    servers: Object.fromEntries(Object.entries(config.servers).map(([id, entry]) => {
      if (entry.type !== "local") return [id, entry];
      const [command0, ...rest] = entry.command;
      const normalizedCommand = command0
        ? [normalizeCommandExecutable(command0, `mcp.servers.${id}`), ...rest]
        : entry.command;
      return [id, {
        ...entry,
        command: normalizedCommand,
        ...(entry.cwd !== undefined ? { cwd: normalizeDirectoryPath(entry.cwd, `mcp.servers.${id}.cwd`) } : {}),
      } satisfies LocalMcpServerConfig];
    })),
  };
}
function normalizeSettingsPaths(settings: PiBaseSettings): PiBaseSettings {
  return {
    ...(settings.lsp ? { lsp: normalizeLspConfigPaths(settings.lsp) } : {}),
    ...(settings.permission ? { permission: settings.permission } : {}),
    ...(settings.render ? { render: settings.render } : {}),
    ...(settings.notify ? { notify: settings.notify } : {}),
    ...(settings.yolo !== undefined ? { yolo: settings.yolo } : {}),
    ...(settings.mcp ? { mcp: normalizeMcpConfigPaths(settings.mcp) } : {}),
    ...(settings.contextCompression ? { contextCompression: settings.contextCompression } : {}),
    ...(settings.subagent ? { subagent: settings.subagent } : {}),
    ...(settings.defaultAgent !== undefined ? { defaultAgent: settings.defaultAgent } : {}),
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
  const collapsedToolResultMaxChars = mergeCollapsedToolResultMaxCharsConfig(base?.collapsedToolResultMaxChars, override?.collapsedToolResultMaxChars);
  if (collapsedToolResultLines === undefined && collapsedToolResultMaxChars === undefined) return undefined;
  return {
    ...(collapsedToolResultLines !== undefined ? { collapsedToolResultLines } : {}),
    ...(collapsedToolResultMaxChars !== undefined ? { collapsedToolResultMaxChars } : {}),
  };
}
function mergeNotify(base: NotifyConfig | undefined, override: NotifyConfig | undefined): NotifyConfig | undefined {
  if (!base && !override) return undefined;
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function mergeYolo(base: YoloMode | undefined, override: YoloMode | undefined): YoloMode | undefined {
  return override ?? base;
}
function mergeMcp(base: McpConfig | undefined, override: McpConfig | undefined): McpConfig | undefined {
  if (!base && !override) return undefined;
  const servers = { ...(base?.servers ?? {}), ...(override?.servers ?? {}) };
  const startupTimeoutMs = override?.startupTimeoutMs ?? base?.startupTimeoutMs;
  const callTimeoutMs = override?.callTimeoutMs ?? base?.callTimeoutMs;
  if (Object.keys(servers).length === 0 && startupTimeoutMs === undefined && callTimeoutMs === undefined) return undefined;
  const output: McpConfig = { servers };
  if (startupTimeoutMs !== undefined) output.startupTimeoutMs = startupTimeoutMs;
  if (callTimeoutMs !== undefined) output.callTimeoutMs = callTimeoutMs;
  return output;
}

function mergeSubagent(base: SubagentConfig | undefined, override: SubagentConfig | undefined): SubagentConfig | undefined {
  if (!base && !override) return undefined;
  const output: SubagentConfig = {
    ...(base?.maxDepth !== undefined || override?.maxDepth !== undefined ? { maxDepth: override?.maxDepth ?? base?.maxDepth } : {}),
    ...(base?.maxConcurrency !== undefined || override?.maxConcurrency !== undefined ? { maxConcurrency: override?.maxConcurrency ?? base?.maxConcurrency } : {}),
    ...(base?.maxTotalConcurrency !== undefined || override?.maxTotalConcurrency !== undefined
      ? { maxTotalConcurrency: override?.maxTotalConcurrency ?? base?.maxTotalConcurrency }
      : {}),
    ...(base?.idleTimeoutMs !== undefined || override?.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: override?.idleTimeoutMs ?? base?.idleTimeoutMs }
      : {}),
    ...(base?.maxTurns !== undefined || override?.maxTurns !== undefined ? { maxTurns: override?.maxTurns ?? base?.maxTurns } : {}),
  };
  return Object.keys(output).length > 0 ? output : undefined;
}

function mergeDefaultAgent(base: string | undefined, override: string | undefined): string | undefined {
  return override ?? base;
}

function cloneContextCompressionTools(value: string[] | undefined): string[] | undefined {
  return value === undefined ? undefined : [...value];
}

function cloneContextCompressionProviders(value: string[] | undefined): string[] | undefined {
  return value === undefined ? undefined : [...value];
}

function mergeContextCompression(
  base: ContextCompressionConfig | undefined,
  override: ContextCompressionConfig | undefined,
): ContextCompressionConfig | undefined {
  if (!base && !override) return undefined;
  const tools = override?.tools !== undefined ? cloneContextCompressionTools(override.tools) : cloneContextCompressionTools(base?.tools);
  const enabledProviders = override?.enabledProviders !== undefined
    ? cloneContextCompressionProviders(override.enabledProviders)
    : cloneContextCompressionProviders(base?.enabledProviders);
  const disabledProviders = override?.disabledProviders !== undefined
    ? cloneContextCompressionProviders(override.disabledProviders)
    : cloneContextCompressionProviders(base?.disabledProviders);
  const output: ContextCompressionConfig = {
    ...(base?.anchorHygiene !== undefined || override?.anchorHygiene !== undefined ? { anchorHygiene: override?.anchorHygiene ?? base?.anchorHygiene } : {}),
    ...(base?.retainedUserMessageRounds !== undefined || override?.retainedUserMessageRounds !== undefined
      ? { retainedUserMessageRounds: override?.retainedUserMessageRounds ?? base?.retainedUserMessageRounds }
      : {}),
    ...(base?.retainedAssistantTurns !== undefined || override?.retainedAssistantTurns !== undefined
      ? { retainedAssistantTurns: override?.retainedAssistantTurns ?? base?.retainedAssistantTurns }
      : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(enabledProviders !== undefined ? { enabledProviders } : {}),
    ...(disabledProviders !== undefined ? { disabledProviders } : {}),
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
      notify: mergeNotify(globalSettings.notify, projectSettings.notify),
      yolo: mergeYolo(globalSettings.yolo, projectSettings.yolo),
      mcp: mergeMcp(globalSettings.mcp, projectSettings.mcp),
      contextCompression: mergeContextCompression(globalSettings.contextCompression, projectSettings.contextCompression),
      subagent: mergeSubagent(globalSettings.subagent, projectSettings.subagent),
      defaultAgent: mergeDefaultAgent(globalSettings.defaultAgent, projectSettings.defaultAgent),
    },
  };
}
