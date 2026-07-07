import { FooterComponent, type AgentSession, type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const GLOBAL_PI_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
export const PI_BASE_AGENT_STATUS_KEY = "pi-base-agent";
export const PI_BASE_PERMISSION_STATUS_KEY = "pi-base-permission";
export const PI_BASE_INLINE_STATUS_KEYS = [PI_BASE_AGENT_STATUS_KEY, PI_BASE_PERMISSION_STATUS_KEY] as const;

interface PiSettingsCacheEntry {
  mtimeMs: number;
  enabled: boolean | undefined;
}

const piSettingsCache = new Map<string, PiSettingsCacheEntry>();
interface FooterSessionAdapter {
  state: {
    model: ExtensionContext["model"];
    thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  };
  sessionManager: ExtensionContext["sessionManager"];
  modelRegistry: ExtensionContext["modelRegistry"];
  getContextUsage: ExtensionContext["getContextUsage"];
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function findProjectPiSettingsPath(cwd: string): string | undefined {
  let dir = resolve(cwd);
  let previous = "";
  while (dir !== previous) {
    const candidate = join(dir, ".pi", "settings.json");
    if (existsSync(candidate)) return candidate;
    previous = dir;
    dir = dirname(dir);
  }
  return undefined;
}

function readCompactionEnabledFromFile(path: string | undefined): boolean | undefined {
  if (!path || !existsSync(path)) return undefined;

  try {
    const stat = statSync(path);
    const cached = piSettingsCache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.enabled;

    const parsed = JSON.parse(readFileSync(path, "utf8")) as { compaction?: { enabled?: unknown } };
    const enabled = typeof parsed.compaction?.enabled === "boolean" ? parsed.compaction.enabled : undefined;
    piSettingsCache.set(path, { mtimeMs: stat.mtimeMs, enabled });
    return enabled;
  } catch {
    piSettingsCache.delete(path);
    return undefined;
  }
}

function resolveAutoCompactionEnabled(cwd: string): boolean {
  const projectEnabled = readCompactionEnabledFromFile(findProjectPiSettingsPath(cwd));
  if (projectEnabled !== undefined) return projectEnabled;

  const globalEnabled = readCompactionEnabledFromFile(GLOBAL_PI_SETTINGS_PATH);
  return globalEnabled ?? true;
}

function createFooterSessionAdapter(ctx: ExtensionContext, pi: Pick<ExtensionAPI, "getThinkingLevel">): FooterSessionAdapter {
  return {
    get state() {
      return {
        model: ctx.model,
        thinkingLevel: pi.getThinkingLevel(),
      };
    },
    sessionManager: ctx.sessionManager,
    modelRegistry: ctx.modelRegistry,
    getContextUsage: () => ctx.getContextUsage(),
  };
}

function hideStatus(footerData: ReadonlyFooterDataProvider, statusKeys: readonly string[]): ReadonlyFooterDataProvider {
  const keys = new Set(statusKeys);
  return {
    getGitBranch: () => footerData.getGitBranch(),
    getAvailableProviderCount: () => footerData.getAvailableProviderCount(),
    onBranchChange: (callback) => footerData.onBranchChange(callback),
    getExtensionStatuses: () => {
      const statuses = new Map(footerData.getExtensionStatuses());
      for (const key of keys) statuses.delete(key);
      return statuses;
    },
  };
}

function fitStatus(status: string, width: number, theme: Theme): { text: string; width: number } {
  if (width <= 0) return { text: "", width: 0 };

  const text = visibleWidth(status) >= width
    ? truncateToWidth(status, width, theme.fg("dim", "..."))
    : ` ${status}`;
  return { text, width: visibleWidth(text) };
}

class InlineStatusFooterComponent extends FooterComponent {
  private readonly rawFooterData: ReadonlyFooterDataProvider;
  private readonly theme: Theme;
  private readonly statusKeys: readonly string[];
  private readonly getCwd: () => string;

  constructor(
    ctx: ExtensionContext,
    pi: Pick<ExtensionAPI, "getThinkingLevel">,
    footerData: ReadonlyFooterDataProvider,
    theme: Theme,
    statusKeys: readonly string[],
  ) {
    const session = createFooterSessionAdapter(ctx, pi);
    super(session as unknown as AgentSession, hideStatus(footerData, statusKeys));
    this.rawFooterData = footerData;
    this.theme = theme;
    this.statusKeys = statusKeys;
    this.getCwd = () => session.sessionManager.getCwd();
  }

  render(width: number): string[] {
    super.setAutoCompactEnabled(resolveAutoCompactionEnabled(this.getCwd()));

    const segments: string[] = [];
    for (const key of this.statusKeys) {
      const text = sanitizeStatusText(this.rawFooterData.getExtensionStatuses().get(key) ?? "");
      if (text) segments.push(text);
    }
    if (segments.length === 0) return super.render(width);
    const inlineStatusText = segments.join(" ");
    const inlineStatus = `${inlineStatusText} `;
    const inlineWidth = visibleWidth(inlineStatus);
    if (inlineWidth >= width) {
      const priorityStatus = segments[0] ?? inlineStatusText;
      return [truncateToWidth(priorityStatus, width, this.theme.fg("dim", "..."))];
    }

    const lines = super.render(Math.max(0, width - inlineWidth));
    const targetLine = Math.max(0, lines.length - 1);
    if (lines.length === 0) return [inlineStatusText];

    return lines.map((line, index) => index === targetLine ? `${inlineStatus}${line}` : line);
  }
}

export function syncInlineStatusFooter(
  ctx: ExtensionContext,
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  options: { enabled?: boolean; statusKeys?: readonly string[] } = {},
): boolean {
  if (!ctx.hasUI || options.enabled === false) return false;

  const statusKeys = options.statusKeys ?? PI_BASE_INLINE_STATUS_KEYS;
  if (statusKeys.length === 0) return false;

  ctx.ui.setFooter((_tui, theme, footerData) => new InlineStatusFooterComponent(ctx, pi, footerData, theme, statusKeys));
  return true;
}

export function syncYoloFooter(
  ctx: ExtensionContext,
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  options: { enabled?: boolean; statusKey: string; extraStatusKeys?: readonly string[] },
): boolean {
  const statusKeys = options.extraStatusKeys && options.extraStatusKeys.length > 0
    ? options.extraStatusKeys
    : [options.statusKey];
  return syncInlineStatusFooter(ctx, pi, { enabled: options.enabled, statusKeys });
}
