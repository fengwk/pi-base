import { FooterComponent, type AgentSession, type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const GLOBAL_PI_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

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

function hideStatus(footerData: ReadonlyFooterDataProvider, statusKey: string): ReadonlyFooterDataProvider {
  return {
    getGitBranch: () => footerData.getGitBranch(),
    getAvailableProviderCount: () => footerData.getAvailableProviderCount(),
    onBranchChange: (callback) => footerData.onBranchChange(callback),
    getExtensionStatuses: () => {
      const statuses = new Map(footerData.getExtensionStatuses());
      statuses.delete(statusKey);
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

class InlineYoloFooterComponent extends FooterComponent {
  private readonly rawFooterData: ReadonlyFooterDataProvider;
  private readonly theme: Theme;
  private readonly statusKey: string;
  private readonly getCwd: () => string;

  constructor(
    ctx: ExtensionContext,
    pi: Pick<ExtensionAPI, "getThinkingLevel">,
    footerData: ReadonlyFooterDataProvider,
    theme: Theme,
    statusKey: string,
  ) {
    const session = createFooterSessionAdapter(ctx, pi);
    super(session as unknown as AgentSession, hideStatus(footerData, statusKey));
    this.rawFooterData = footerData;
    this.theme = theme;
    this.statusKey = statusKey;
    this.getCwd = () => session.sessionManager.getCwd();
  }

  render(width: number): string[] {
    super.setAutoCompactEnabled(resolveAutoCompactionEnabled(this.getCwd()));

    const status = sanitizeStatusText(this.rawFooterData.getExtensionStatuses().get(this.statusKey) ?? "");
    if (!status) return super.render(width);

    const inlineStatus = fitStatus(status, width, this.theme);
    if (!inlineStatus.text) return super.render(width);
    if (width - inlineStatus.width <= 0) return [inlineStatus.text.trimStart()];

    const lines = super.render(Math.max(0, width - inlineStatus.width));
    const targetLine = lines.length > 1 ? 1 : 0;
    if (lines.length === 0) return [inlineStatus.text.trimStart()];

    return lines.map((line, index) => index === targetLine ? `${line}${inlineStatus.text}` : line);
  }
}

export function syncYoloFooter(
  ctx: ExtensionContext,
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  options: { enabled: boolean; statusKey: string },
): boolean {
  if (!ctx.hasUI) return false;

  if (!options.enabled) {
    ctx.ui.setFooter(undefined);
    return false;
  }

  ctx.ui.setFooter((_tui, theme, footerData) => new InlineYoloFooterComponent(ctx, pi, footerData, theme, options.statusKey));
  return true;
}
