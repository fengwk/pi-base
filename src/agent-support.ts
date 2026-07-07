import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { formatSkillsForPrompt, getAgentDir, parseFrontmatter, type BuildSystemPromptOptions, type ExtensionAPI, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";

const DEFAULT_AGENT_NAME = "default";
const AGENT_STATE_ENTRY = "pi-base-agent-state";
const AGENT_STATUS_KEY = "pi-base-agent";
const PROJECT_CONFIG_DIR = ".pi";
const AGENTS_DIR = "agents";
const SETTINGS_FILE = "settings.json";
const SYSTEM_PROMPT_FILE = "SYSTEM.md";
const AGENT_SELECTOR_ITEM_MAX_COLUMNS = 120;
const AGENT_COMPLETION_DESCRIPTION_MAX_COLUMNS = 96;

const VALID_THINKING_LEVELS = new Set<ReturnType<ExtensionAPI["getThinkingLevel"]>>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface AgentFrontmatter {
  name?: unknown;
  description?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  tools?: unknown;
  skills?: unknown;
  [key: string]: unknown;
}

interface AgentModelRef {
  provider: string;
  modelId: string;
}

interface AgentDefinition {
  name: string;
  description?: string;
  filePath: string;
  prompt?: string;
  model?: AgentModelRef;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  skills?: string[];
}

interface AgentCatalog {
  agents: AgentDefinition[];
  byName: Map<string, AgentDefinition>;
  diagnostics: string[];
}

interface MergedSettingsDefaults {
  model?: AgentModelRef;
  thinkingLevel?: ThinkingLevel;
}

export function registerAgentSupport(
  pi: Pick<
    ExtensionAPI,
    "appendEntry" | "getActiveTools" | "getAllTools" | "getThinkingLevel" | "on" | "registerCommand" | "setActiveTools" | "setModel" | "setThinkingLevel"
  >,
  options: { baseToolGuide: string },
): void {
  let catalog = loadAgentCatalog();
  let activeAgentName = DEFAULT_AGENT_NAME;

  const refreshCatalog = (): AgentCatalog => {
    catalog = loadAgentCatalog();
    return catalog;
  };

  const warnDiagnostics = (ctx: ExtensionContext, diagnostics: string[]): void => {
    if (diagnostics.length === 0) return;
    for (const message of diagnostics) {
      console.warn(message);
    }
    if (ctx.hasUI) {
      ctx.ui.notify(`Loaded agents with ${diagnostics.length} warning(s); see stderr for details.`, "warning");
    }
  };

  const allRegisteredToolNames = (): string[] => pi.getAllTools().map((tool) => tool.name);

  const updateStatus = (ctx: ExtensionContext, agentName: string): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      AGENT_STATUS_KEY,
      agentName === DEFAULT_AGENT_NAME ? undefined : ctx.ui.theme.fg("accent", `agent:${agentName}`),
    );
  };

  const persistActiveAgent = (agentName: string): void => {
    pi.appendEntry(AGENT_STATE_ENTRY, { name: agentName });
  };

  const resolveAgent = (name: string): AgentDefinition | undefined => {
    if (name === DEFAULT_AGENT_NAME) return catalog.byName.get(DEFAULT_AGENT_NAME);
    return catalog.byName.get(name);
  };

  const applyAgent = async (
    requestedName: string,
    ctx: ExtensionContext,
    options: { persist: boolean; notify: boolean },
  ): Promise<boolean> => {
    const agent = resolveAgent(requestedName);
    if (!agent) {
      if (options.notify && ctx.hasUI) {
        ctx.ui.notify(buildUnknownAgentMessage(requestedName, catalog.agents.map((item) => item.name)), "error");
      }
      return false;
    }

    const defaults = loadMergedSettingsDefaults(ctx.cwd);
    const validTools = filterKnownTools(agent.tools, allRegisteredToolNames());

    const effectiveModel = agent.model ?? defaults.model;
    if (effectiveModel) {
      const model = findModel(ctx, effectiveModel);
      if (!model) {
        if (options.notify && ctx.hasUI) {
          ctx.ui.notify(
            `Agent "${agent.name}": model ${effectiveModel.provider}/${effectiveModel.modelId} not found. Check the provider name, model ID, and enabled models configuration.`,
            "error",
          );
        }
        return false;
      }
      try {
        const success = await pi.setModel(model);
        if (!success) {
          if (options.notify && ctx.hasUI) {
            ctx.ui.notify(`Agent "${agent.name}": no auth configured for ${effectiveModel.provider}/${effectiveModel.modelId}.`, "error");
          }
          return false;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Agent "${agent.name}": failed to activate model ${effectiveModel.provider}/${effectiveModel.modelId}: ${message}`);
        if (options.notify && ctx.hasUI) {
          ctx.ui.notify(
            `Agent "${agent.name}": failed to activate model ${effectiveModel.provider}/${effectiveModel.modelId}. Check the provider, model ID, and auth configuration.`,
            "error",
          );
        }
        return false;
      }
    }

    const effectiveThinkingLevel = agent.thinkingLevel ?? defaults.thinkingLevel;
    if (effectiveThinkingLevel) {
      try {
        pi.setThinkingLevel(effectiveThinkingLevel);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Agent "${agent.name}": failed to apply thinking level ${effectiveThinkingLevel}: ${message}`);
        if (options.notify && ctx.hasUI) {
          ctx.ui.notify(
            `Agent "${agent.name}": failed to apply thinking level ${effectiveThinkingLevel}. Check the selected model and provider configuration.`,
            "error",
          );
        }
        return false;
      }
    }

    pi.setActiveTools(validTools);

    activeAgentName = agent.name;
    updateStatus(ctx, agent.name);
    if (options.persist) {
      persistActiveAgent(agent.name);
    }
    if (options.notify && ctx.hasUI) {
      ctx.ui.notify(`Agent "${agent.name}" activated.`, "info");
    }
    return true;
  };

  const pickAgentFromEntries = (ctx: ExtensionContext): { name: string; persisted: boolean } => {
    const entry = ctx.sessionManager
      .getEntries()
      .filter((item: { type: string; customType?: string }) => item.type === "custom" && item.customType === AGENT_STATE_ENTRY)
      .pop() as { data?: { name?: string } } | undefined;
    const requestedName = typeof entry?.data?.name === "string" ? entry.data.name.trim() : "";
    if (!requestedName) return { name: DEFAULT_AGENT_NAME, persisted: false };
    return {
      name: catalog.byName.has(requestedName) ? requestedName : DEFAULT_AGENT_NAME,
      persisted: true,
    };
  };

  const selectAgent = async (ctx: ExtensionContext): Promise<string | undefined> => {
    const itemToAgentName = new Map<string, string>();
    const items = catalog.agents.map((agent) => {
      const item = buildAgentSelectorItem(agent);
      itemToAgentName.set(item, agent.name);
      return item;
    });
    const selected = await ctx.ui.select("Select agent", items);
    if (!selected) return undefined;
    return itemToAgentName.get(selected);
  };

  const safeApplyAgent = async (
    agentName: string,
    ctx: ExtensionContext,
    applyOptions: { persist: boolean; notify: boolean },
  ): Promise<boolean> => {
    try {
      return await applyAgent(agentName, ctx, applyOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Agent \"${agentName}\": unexpected activation failure: ${message}`, error);
      if (applyOptions.notify && ctx.hasUI) {
        ctx.ui.notify(`Agent "${agentName}": activation failed: ${message}`, "error");
      }
      return false;
    }
  };

  pi.registerCommand("agent", {
    description: "Switch agent (/agent <name>, /agent default, or /agent with selector)",
    getArgumentCompletions: (prefix) => {
      const nextCatalog = refreshCatalog();
      const loweredPrefix = prefix.trim().toLowerCase();
      const matches = nextCatalog.agents.filter((agent) => agent.name.toLowerCase().startsWith(loweredPrefix));
      if (matches.length === 0) return null;
      return matches.map((agent) => ({
        value: agent.name,
        label: agent.name,
        description: truncateDisplayWidth(agent.description ?? buildAgentSummary(agent), AGENT_COMPLETION_DESCRIPTION_MAX_COLUMNS),
      }));
    },
    handler: async (args, ctx) => {
      const nextCatalog = refreshCatalog();
      warnDiagnostics(ctx, nextCatalog.diagnostics);

      const requested = args.trim();
      const agentName = requested || (ctx.hasUI ? await selectAgent(ctx) : undefined);
      if (!agentName) {
        if (requested.length === 0 && ctx.hasUI) return;
        if (ctx.hasUI) {
          ctx.ui.notify(`Usage: /agent <name>. Available: ${nextCatalog.agents.map((agent) => agent.name).join(", ")}`, "warning");
        }
        return;
      }

      await safeApplyAgent(agentName, ctx, { persist: true, notify: true });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const nextCatalog = refreshCatalog();
    warnDiagnostics(ctx, nextCatalog.diagnostics);
    const requested = pickAgentFromEntries(ctx);
    if (!requested.persisted) {
      activeAgentName = DEFAULT_AGENT_NAME;
      updateStatus(ctx, DEFAULT_AGENT_NAME);
      return;
    }
    const applied = await safeApplyAgent(requested.name, ctx, { persist: false, notify: false });
    if (!applied && requested.name !== DEFAULT_AGENT_NAME) {
      await safeApplyAgent(DEFAULT_AGENT_NAME, ctx, { persist: false, notify: false });
    }
  });

  pi.on("before_agent_start", async (event) => {
    const activeAgent = resolveAgent(activeAgentName) ?? catalog.byName.get(DEFAULT_AGENT_NAME);
    if (!activeAgent) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${options.baseToolGuide}`,
      };
    }

    const selectedTools = event.systemPromptOptions.selectedTools ?? pi.getActiveTools();
    const allSkills = event.systemPromptOptions.skills ?? [];
    const visibleSkills = skillsRenderableInPrompt(filterVisibleSkills(allSkills, activeAgent.skills));
    const systemPrompt = buildAgentSystemPrompt(
      {
        ...event.systemPromptOptions,
        customPrompt: resolveCustomPrompt(activeAgent, event.systemPromptOptions.customPrompt),
        selectedTools,
        skills: visibleSkills,
      },
      event.systemPrompt,
    );

    return {
      systemPrompt: `${systemPrompt}\n\n${options.baseToolGuide}`,
    };
  });
}

function findModel(ctx: ExtensionContext, ref: AgentModelRef): Model<Api> | undefined {
  const finder = (ctx.modelRegistry as { find?: (provider: string, modelId: string) => Model<Api> | undefined }).find;
  if (typeof finder !== "function") return undefined;
  return finder(ref.provider, ref.modelId);
}

function buildUnknownAgentMessage(name: string, availableAgents: string[]): string {
  const suffix = availableAgents.length > 0 ? ` Available: ${availableAgents.join(", ")}` : "";
  return `Unknown agent "${name}".${suffix}`;
}

function buildAgentSummary(agent: AgentDefinition): string {
  const parts: string[] = [];
  if (agent.description) {
    parts.push(agent.description);
  }
  if (agent.model) {
    parts.push(`${agent.model.provider}/${agent.model.modelId}`);
  }
  if (agent.thinkingLevel) {
    parts.push(`thinking:${agent.thinkingLevel}`);
  }
  return parts.join(" | ");
}

function buildAgentSelectorItem(agent: AgentDefinition): string {
  const summary = buildAgentSummary(agent);
  if (!summary) return agent.name;
  const prefix = `${agent.name} - `;
  return `${prefix}${truncateDisplayWidth(summary, Math.max(0, AGENT_SELECTOR_ITEM_MAX_COLUMNS - stringDisplayWidth(prefix)))}`;
}

function truncateDisplayWidth(value: string, maxColumns: number): string {
  if (stringDisplayWidth(value) <= maxColumns) return value;
  if (maxColumns <= 1) return "…";

  let output = "";
  let usedColumns = 0;
  for (const char of value) {
    const charColumns = charDisplayWidth(char);
    if (usedColumns + charColumns > maxColumns - 1) break;
    output += char;
    usedColumns += charColumns;
  }
  return `${output}…`;
}

function stringDisplayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += charDisplayWidth(char);
  }
  return width;
}

function charDisplayWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (isFullwidthCodePoint(codePoint)) return 2;
  return 1;
}

function isFullwidthCodePoint(codePoint: number): boolean {
  if (codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f) ||
    (codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0xa4c6) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6b) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b001) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )) {
    return true;
  }
  return false;
}

function filterKnownTools(toolNames: string[] | undefined, allToolNames: string[]): string[] {
  if (toolNames === undefined) return [...allToolNames];
  const known = new Set(allToolNames);
  return toolNames.filter((toolName) => known.has(toolName));
}

function filterVisibleSkills(skills: Skill[], allowedSkillNames: string[] | undefined): Skill[] {
  if (allowedSkillNames === undefined) return skills;
  const allowed = new Set(allowedSkillNames);
  return skills.filter((skill) => allowed.has(skill.name));
}

/** Matches Pi `formatSkillsForPrompt`: skills marked disable-model-invocation stay CLI-only. */
function skillsRenderableInPrompt(skills: Skill[]): Skill[] {
  return skills.filter((skill) => !skill.disableModelInvocation);
}

function resolveCustomPrompt(agent: AgentDefinition, fallbackCustomPrompt: string | undefined): string | undefined {
  return agent.prompt ?? fallbackCustomPrompt;
}

/**
 * Keep this aligned with Pi's `buildSystemPrompt` custom-prompt branch until the core package
 * exports that helper as a stable public API. When no custom prompt source exists, preserve
 * Pi's prebuilt system prompt as the fallback.
 */
function buildAgentSystemPrompt(options: BuildSystemPromptOptions, fallbackSystemPrompt: string): string {
  const customPrompt = options.customPrompt?.trim();
  if (!customPrompt) {
    return fallbackSystemPrompt;
  }

  const appendSection = options.appendSystemPrompt ? `\n\n${options.appendSystemPrompt}` : "";
  const promptCwd = options.cwd.replace(/\\/g, "/");
  const contextFiles = options.contextFiles ?? [];
  const selectedTools = options.selectedTools;
  const skills = options.skills ?? [];

  let prompt = customPrompt;
  if (appendSection) {
    prompt += appendSection;
  }

  if (contextFiles.length > 0) {
    prompt += "\n\n# Project Context\n\n";
    prompt += "Project-specific instructions and guidelines:\n\n";
    for (const { path: filePath, content } of contextFiles) {
      prompt += `## ${filePath}\n\n${content}\n\n`;
    }
  }

  const customPromptHasRead = !selectedTools || selectedTools.includes("read");
  if (customPromptHasRead && skills.length > 0) {
    prompt += formatSkillsForPrompt(skills);
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  prompt += `\nCurrent date: ${year}-${month}-${day}`;
  prompt += `\nCurrent working directory: ${promptCwd}`;
  return prompt;
}

function loadMergedSettingsDefaults(cwd: string): MergedSettingsDefaults {
  const globalSettings = readSettingsFile(join(getAgentDir(), SETTINGS_FILE));
  const projectSettings = readSettingsFile(join(cwd, PROJECT_CONFIG_DIR, SETTINGS_FILE));
  const provider = asTrimmedString(projectSettings.defaultProvider) ?? asTrimmedString(globalSettings.defaultProvider);
  const modelId = asTrimmedString(projectSettings.defaultModel) ?? asTrimmedString(globalSettings.defaultModel);
  const thinkingLevel = normalizeThinkingLevel(projectSettings.defaultThinkingLevel)
    ?? normalizeThinkingLevel(globalSettings.defaultThinkingLevel);

  return {
    ...(provider && modelId ? { model: { provider, modelId } } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

function readSettingsFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function loadAgentCatalog(): AgentCatalog {
  const diagnostics: string[] = [];
  const byName = new Map<string, AgentDefinition>();
  const agents: AgentDefinition[] = [];

  const defaultAgent = createDefaultAgentDefinition();
  byName.set(defaultAgent.name, defaultAgent);
  agents.push(defaultAgent);

  const agentsDir = join(getAgentDir(), AGENTS_DIR);
  const filePaths = listMarkdownFiles(agentsDir);
  for (const filePath of filePaths) {
    try {
      const agent = loadAgentFile(filePath);
      if (byName.has(agent.name)) {
        diagnostics.push(`pi-base agent warning: duplicate agent name "${agent.name}" at ${filePath}; ignoring this file.`);
        continue;
      }
      byName.set(agent.name, agent);
      agents.push(agent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(`pi-base agent warning: ${message}`);
    }
  }

  agents.sort((left, right) => {
    if (left.name === DEFAULT_AGENT_NAME) return -1;
    if (right.name === DEFAULT_AGENT_NAME) return 1;
    return left.name.localeCompare(right.name);
  });

  return { agents, byName, diagnostics };
}

function createDefaultAgentDefinition(): AgentDefinition {
  return {
    name: DEFAULT_AGENT_NAME,
    description: `Use ${SYSTEM_PROMPT_FILE} plus settings.json defaults.`,
    filePath: join(getAgentDir(), SYSTEM_PROMPT_FILE),
  };
}

function loadAgentFile(filePath: string): AgentDefinition {
  const content = readFileSync(filePath, "utf8");
  const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
  const fallbackName = basename(filePath, extname(filePath));
  const name = normalizeName(frontmatter.name, fallbackName, filePath);
  const description = normalizeDescription(frontmatter.description, filePath);
  const model = normalizeModel(frontmatter.model, filePath);
  const thinkingLevel = normalizeThinkingLevel(frontmatter.thinkingLevel, filePath);
  const tools = normalizeStringListField(frontmatter.tools, "tools", filePath);
  const skills = normalizeStringListField(frontmatter.skills, "skills", filePath);
  if (name === DEFAULT_AGENT_NAME) {
    throw new Error(`agent file ${filePath} uses reserved name "${DEFAULT_AGENT_NAME}"`);
  }

  return {
    name,
    ...(description ? { description } : {}),
    filePath,
    ...(body.trim() ? { prompt: body.trim() } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(tools ? { tools } : {}),
    ...(skills ? { skills } : {}),
  };
}

function normalizeName(value: unknown, fallbackName: string, filePath: string): string {
  const name = value === undefined ? fallbackName : asTrimmedString(value);
  if (!name) {
    throw new Error(`agent file ${filePath} has an empty name`);
  }
  return name;
}

function normalizeDescription(value: unknown, filePath: string): string | undefined {
  if (value === undefined) return undefined;
  const description = asTrimmedString(value);
  if (!description) {
    throw new Error(`agent file ${filePath} has an empty description`);
  }
  return description;
}

function normalizeModel(value: unknown, filePath: string): AgentModelRef | undefined {
  if (value === undefined) return undefined;
  const raw = asTrimmedString(value);
  if (!raw) {
    throw new Error(`agent file ${filePath} has an empty model`);
  }
  const slashIndex = raw.indexOf("/");
  if (slashIndex <= 0 || slashIndex === raw.length - 1) {
    throw new Error(`agent file ${filePath} must use "provider/model" format for model`);
  }
  return {
    provider: raw.slice(0, slashIndex),
    modelId: raw.slice(slashIndex + 1),
  };
}

function normalizeThinkingLevel(value: unknown, filePath?: string): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  const level = asTrimmedString(value);
  if (!level || !VALID_THINKING_LEVELS.has(level as ThinkingLevel)) {
    if (!filePath) return undefined;
    throw new Error(`agent file ${filePath} has invalid thinkingLevel "${String(value)}"`);
  }
  return level as ThinkingLevel;
}

function normalizeStringListField(value: unknown, fieldName: "tools" | "skills", filePath: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`agent file ${filePath} field "${fieldName}" must be an array of strings`);
  }

  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const next = asTrimmedString(item);
    if (!next) {
      throw new Error(`agent file ${filePath} field "${fieldName}" contains an empty entry`);
    }
    if (seen.has(next)) continue;
    seen.add(next);
    output.push(next);
  }

  return output;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const output: string[] = [];
  walkMarkdownFiles(dir, output, new Set());
  output.sort((left, right) => left.localeCompare(right));
  return output;
}

function walkMarkdownFiles(dir: string, output: string[], visited: Set<string>): void {
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return;
  }
  if (visited.has(realDir)) return;
  visited.add(realDir);
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(fullPath, output, visited);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          walkMarkdownFiles(fullPath, output, visited);
          continue;
        }
        if (stats.isFile() && fullPath.endsWith(".md")) {
          output.push(fullPath);
        }
      } catch {
        continue;
      }
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".md")) {
      output.push(fullPath);
    }
  }
}
