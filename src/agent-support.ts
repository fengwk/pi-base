import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { formatSkillsForPrompt, getAgentDir, parseFrontmatter, type BuildSystemPromptOptions, type ExtensionAPI, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";
import { PI_BASE_AGENT_STATUS_KEY } from "./yolo-footer.js";

const DEFAULT_AGENT_NAME = "default";
/** Custom session entry naming the active agent; also written into subagent sessions at spawn. */
export const AGENT_STATE_ENTRY = "pi-base-agent-state";
const AGENTS_DIR = "agents";
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
  subagents?: unknown;
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
  /** Agent names this agent may delegate to via the `task` tool. Empty/absent => cannot delegate. */
  subagents?: string[];
}

interface AgentCatalog {
  agents: AgentDefinition[];
  byName: Map<string, AgentDefinition>;
  diagnostics: string[];
}

export interface SubagentControls {
  taskToolName: string;
  getMaxDepth: (cwd: string) => number;
  readDepth: (ctx: ExtensionContext) => number;
}

export interface AgentSupportHandle {
  /** Names the currently-active agent may delegate to (empty when it cannot delegate). */
  getActiveAgentSubagents: () => string[];
  getActiveAgentName: () => string;
  hasAgent: (name: string) => boolean;
  /** Whether the active agent's tool policy allows this tool name when it becomes available later. */
  canActivateTool: (toolName: string) => boolean;
}

export function registerAgentSupport(
  pi: Pick<
    ExtensionAPI,
    "appendEntry" | "getActiveTools" | "getAllTools" | "getThinkingLevel" | "on" | "registerCommand" | "setActiveTools" | "setModel" | "setThinkingLevel"
  >,
  options: {
    baseToolGuide: string;
    subagentControls?: SubagentControls;
    getStartupAgentName?: () => string | undefined;
    getConfiguredDefaultAgentName?: (cwd: string) => string | undefined;
    /** Filters registered tool definitions that should not be offered to agents right now. */
    isToolActivatable?: (toolName: string) => boolean;
  },
): AgentSupportHandle {
  let catalog = loadAgentCatalog();
  let activeAgentName = DEFAULT_AGENT_NAME;
  const subagentControls = options.subagentControls;

  // Add/remove the `task` delegation tool for the active agent: present only when the agent
  // declares a non-empty `subagents` list and this session is still below maxDepth.
  const applyTaskInjection = (tools: string[], agent: AgentDefinition, ctx: ExtensionContext): string[] => {
    if (!subagentControls) return tools;
    const withoutTask = tools.filter((name) => name !== subagentControls.taskToolName);
    const registered = allRegisteredToolNames().includes(subagentControls.taskToolName);
    const canDelegate =
      registered &&
      (agent.subagents?.length ?? 0) > 0 &&
      subagentControls.readDepth(ctx) < subagentControls.getMaxDepth(ctx.cwd);
    return canDelegate ? [...withoutTask, subagentControls.taskToolName] : withoutTask;
  };

  // System-prompt section listing the subagents the active agent may delegate to (name +
  // description). Gated on `task` being active this turn — applyTaskInjection already encoded
  // the depth/subagents decision into the active tool set, so this stays a single source of truth.
  //
  // Mirrors opencode's <available_skills>/<available_references> pattern: a clear XML envelope
  // (`<available_subagents>` containing one `<subagent>` element per delegate) is much easier for
  // the model to parse than nested bullet lists, and matches the rest of pi-base's prompt XML.
  const buildSubagentSection = (agent: AgentDefinition, activeTools: string[]): string => {
    if (!subagentControls || !activeTools.includes(subagentControls.taskToolName)) return "";
    const names = agent.subagents ?? [];
    if (names.length === 0) return "";
    const entries = names.map((name) => {
      const sub = resolveAgent(name);
      const description = sub?.description?.trim() || (sub ? "(no description)" : "(agent not found)");
      return [
        "  <subagent>",
        `    <name>${escapeXml(name)}</name>`,
        `    <description>${escapeXml(description)}</description>`,
        "  </subagent>",
      ].join("\n");
    });
    return [
      "You can delegate a self-contained task to a subagent with the `task` tool. Set `subagent_type` to one of the names listed below.",
      "",
      "<available_subagents>",
      entries.join("\n"),
      "</available_subagents>",
    ].join("\n");
  };

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

  const warnStartupAgentFallback = (ctx: ExtensionContext, message: string): void => {
    console.warn(`pi-base agent warning: ${message}`);
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
  };

  const allRegisteredToolNames = (): string[] => pi.getAllTools()
    .map((tool) => tool.name)
    .filter((toolName) => options.isToolActivatable?.(toolName) ?? true);

  const updateStatus = (ctx: ExtensionContext, agentName: string): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      PI_BASE_AGENT_STATUS_KEY,
      ctx.ui.theme.fg("accent", `agent:${agentName === DEFAULT_AGENT_NAME ? DEFAULT_AGENT_NAME : agentName}`),
    );
  };

  const persistActiveAgent = (agentName: string): void => {
    pi.appendEntry(AGENT_STATE_ENTRY, { name: agentName });
  };

  const resolveAgent = (name: string): AgentDefinition | undefined => {
    if (name === DEFAULT_AGENT_NAME) return catalog.byName.get(DEFAULT_AGENT_NAME);
    return catalog.byName.get(name);
  };
  const resolveActiveAgent = (): AgentDefinition | undefined => resolveAgent(activeAgentName) ?? catalog.byName.get(DEFAULT_AGENT_NAME);
  const canActivateToolForActiveAgent = (toolName: string): boolean => {
    const agent = resolveActiveAgent();
    if (!agent?.tools) return agent?.tools === undefined;
    return agent.tools.includes(toolName);
  };

  const applyAgent = async (
    requestedName: string,
    ctx: ExtensionContext,
    options: { persist: boolean; notify: boolean; applyModelThinking: boolean },
  ): Promise<boolean> => {
    const agent = resolveAgent(requestedName);
    if (!agent) {
      if (options.notify && ctx.hasUI) {
        ctx.ui.notify(buildUnknownAgentMessage(requestedName, catalog.agents.map((item) => item.name)), "error");
      }
      return false;
    }

    const validTools = filterKnownTools(agent.tools, allRegisteredToolNames());

    let canApplyThinkingLevel = options.applyModelThinking;
    if (options.applyModelThinking && agent.model) {
      const model = findModel(ctx, agent.model);
      if (!model) {
        console.warn(`Agent "${agent.name}": model ${agent.model.provider}/${agent.model.modelId} not found. Agent switch will keep the current session model.`);
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Agent "${agent.name}": model ${agent.model.provider}/${agent.model.modelId} not found. Keeping the current session model.`,
            "warning",
          );
        }
        canApplyThinkingLevel = false;
      } else {
        try {
          const success = await pi.setModel(model);
          if (!success) {
            console.warn(`Agent "${agent.name}": no auth configured for ${agent.model.provider}/${agent.model.modelId}. Agent switch will keep the current session model.`);
            if (ctx.hasUI) {
              ctx.ui.notify(`Agent "${agent.name}": no auth configured for ${agent.model.provider}/${agent.model.modelId}. Keeping the current session model.`, "warning");
            }
            canApplyThinkingLevel = false;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`Agent "${agent.name}": failed to activate model ${agent.model.provider}/${agent.model.modelId}: ${message}`);
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Agent "${agent.name}": failed to activate model ${agent.model.provider}/${agent.model.modelId}. Keeping the current session model.`,
              "warning",
            );
          }
          canApplyThinkingLevel = false;
        }
      }
    }

    if (canApplyThinkingLevel && agent.thinkingLevel) {
      try {
        pi.setThinkingLevel(agent.thinkingLevel);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Agent "${agent.name}": failed to apply thinking level ${agent.thinkingLevel}: ${message}`);
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Agent "${agent.name}": failed to apply thinking level ${agent.thinkingLevel}. Keeping the current session thinking level.`,
            "warning",
          );
        }
      }
    }

    pi.setActiveTools(applyTaskInjection(validTools, agent, ctx));

    activeAgentName = agent.name;
    updateStatus(ctx, agent.name);
    if (options.persist) {
      persistActiveAgent(agent.name);
    }
    if (options.notify && ctx.hasUI) {
      const selectedModel = agent.model ? ` model:${agent.model.provider}/${agent.model.modelId}` : "";
      const selectedThinking = agent.thinkingLevel ? ` thinking:${agent.thinkingLevel}` : "";
      const suffix = options.applyModelThinking && (selectedModel || selectedThinking) ? `${selectedModel}${selectedThinking}` : "";
      ctx.ui.notify(`Agent "${agent.name}" activated.${suffix}`, "info");
    }
    return true;
  };

  const pickAgentFromEntries = (ctx: ExtensionContext): { name: string; persisted: boolean; missingRequestedName?: string } => {
    const entry = ctx.sessionManager
      .getEntries()
      .filter((item: { type: string; customType?: string }) => item.type === "custom" && item.customType === AGENT_STATE_ENTRY)
      .pop() as { data?: { name?: string } } | undefined;
    const requestedName = typeof entry?.data?.name === "string" ? entry.data.name.trim() : "";
    if (!requestedName) return { name: DEFAULT_AGENT_NAME, persisted: false };
    if (catalog.byName.has(requestedName)) {
      return { name: requestedName, persisted: true };
    }
    return {
      name: DEFAULT_AGENT_NAME,
      persisted: true,
      missingRequestedName: requestedName,
    };
  };

  const selectAgent = async (ctx: ExtensionContext): Promise<string | undefined> => {
    const itemToAgentName = new Map<string, string>();
    const seenItems = new Map<string, number>();
    const items = catalog.agents.map((agent) => {
      const baseItem = buildAgentSelectorItem(agent);
      const occurrence = (seenItems.get(baseItem) ?? 0) + 1;
      seenItems.set(baseItem, occurrence);
      const item = occurrence === 1 ? baseItem : appendSelectorSuffix(baseItem, ` [${occurrence}]`);
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
    applyOptions: { persist: boolean; notify: boolean; applyModelThinking: boolean },
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
        description: truncateDisplayWidth(buildAgentSummary(agent), AGENT_COMPLETION_DESCRIPTION_MAX_COLUMNS),
      }));
    },
    handler: async (args, ctx) => {
      const nextCatalog = refreshCatalog();
      warnDiagnostics(ctx, nextCatalog.diagnostics);

      const requested = args.trim();
      const agentName = requested || (ctx.hasUI ? await selectAgent(ctx) : undefined);
      if (!agentName) {
        // Interactive selector dismissed: stay quiet. Non-interactive callers get an
        // actionable hint because /agent needs an explicit name without a picker.
        if (ctx.hasUI) return;
        ctx.ui.notify(`Usage: /agent <name>. Available: ${nextCatalog.agents.map((agent) => agent.name).join(", ")}`, "warning");
        return;
      }

      await safeApplyAgent(agentName, ctx, { persist: true, notify: true, applyModelThinking: true });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const nextCatalog = refreshCatalog();
    warnDiagnostics(ctx, nextCatalog.diagnostics);
    const requested = pickAgentFromEntries(ctx);
    if (!requested.persisted) {
      // No agent persisted in this session: honor a startup source when present.
      // Precedence stays simple and explicit: persisted session agent -> --agent ->
      // pi-base.json defaultAgent -> built-in default. Subagent children never reach here
      // (they always carry a persisted agent-state entry and start with empty flag values),
      // so this only affects the root session.
      const startupName = options.getStartupAgentName?.()?.trim();
      if (startupName) {
        if (nextCatalog.byName.has(startupName)) {
          const applied = await safeApplyAgent(startupName, ctx, { persist: true, notify: false, applyModelThinking: true });
          if (applied) return;
        } else {
          warnStartupAgentFallback(ctx, `Agent "${startupName}" (from --agent) not found; using the default agent.`);
        }
      } else {
        const configuredDefaultAgentName = options.getConfiguredDefaultAgentName?.(ctx.cwd)?.trim();
        if (configuredDefaultAgentName) {
          if (nextCatalog.byName.has(configuredDefaultAgentName)) {
            const applied = await safeApplyAgent(configuredDefaultAgentName, ctx, { persist: true, notify: false, applyModelThinking: true });
            if (applied) return;
          } else {
            warnStartupAgentFallback(ctx, `Agent "${configuredDefaultAgentName}" (from pi-base.json defaultAgent) not found; using the default agent.`);
          }
        }
      }
      activeAgentName = DEFAULT_AGENT_NAME;
      updateStatus(ctx, DEFAULT_AGENT_NAME);
      return;
    }
    if (requested.missingRequestedName) {
      warnStartupAgentFallback(ctx, `Agent "${requested.missingRequestedName}" (from session entry) not found; using the default agent.`);
    }
    const applied = await safeApplyAgent(requested.name, ctx, { persist: false, notify: false, applyModelThinking: false });
    if (!applied && requested.name !== DEFAULT_AGENT_NAME) {
      await safeApplyAgent(DEFAULT_AGENT_NAME, ctx, { persist: false, notify: false, applyModelThinking: false });
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

    const subagentSection = buildSubagentSection(activeAgent, selectedTools);
    const guide = subagentSection ? `${options.baseToolGuide}\n\n${subagentSection}` : options.baseToolGuide;
    return {
      systemPrompt: `${systemPrompt}\n\n${guide}`,
    };
  });

  return {
    getActiveAgentSubagents: () => resolveActiveAgent()?.subagents ?? [],
    getActiveAgentName: () => activeAgentName,
    hasAgent: (name: string) => catalog.byName.has(name),
    canActivateTool: (toolName: string) => canActivateToolForActiveAgent(toolName),
  };
}

function findModel(ctx: ExtensionContext, ref: AgentModelRef): Model<Api> | undefined {
  const modelRegistry = ctx.modelRegistry as { find?: (provider: string, modelId: string) => Model<Api> | undefined };
  if (typeof modelRegistry.find !== "function") return undefined;
  return modelRegistry.find(ref.provider, ref.modelId);
}

function buildUnknownAgentMessage(name: string, availableAgents: string[]): string {
  const suffix = availableAgents.length > 0 ? ` Available: ${availableAgents.join(", ")}` : "";
  return `Unknown agent "${name}".${suffix}`;
}

function buildAgentSummary(agent: AgentDefinition): string {
  const parts: string[] = [];
  const singleLineDescription = toSingleLine(agent.description);
  if (singleLineDescription) {
    parts.push(singleLineDescription);
  }
  if (agent.model) {
    parts.push(`${agent.model.provider}/${agent.model.modelId}`);
  }
  if (agent.thinkingLevel) {
    parts.push(`thinking:${agent.thinkingLevel}`);
  }
  return parts.join(" | ");
}

function toSingleLine(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const firstLine = value.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return undefined;
  return firstLine.replace(/\s+/g, " ");
}

function buildAgentSelectorItem(agent: AgentDefinition): string {
  const summary = buildAgentSummary(agent);
  if (!summary) return agent.name;
  const prefix = `${agent.name} - `;
  return `${prefix}${truncateDisplayWidth(summary, Math.max(0, AGENT_SELECTOR_ITEM_MAX_COLUMNS - stringDisplayWidth(prefix)))}`;
}

function appendSelectorSuffix(value: string, suffix: string): string {
  const suffixWidth = stringDisplayWidth(suffix);
  const base = truncateDisplayWidth(value, Math.max(0, AGENT_SELECTOR_ITEM_MAX_COLUMNS - suffixWidth));
  return `${base}${suffix}`;
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

/**
 * Escape a string for safe insertion into an XML text node or attribute value.
 * Mirrors pi-coding-agent's `formatSkillsForPrompt` helper so every XML section in the prompt
 * uses the same escaping rules.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
 * pi-base owns the final system prompt structure: the body comes from either a custom prompt
 * (built locally, mirroring upstream's custom-prompt branch) or upstream's prebuilt prompt
 * (used as a body source). The trailing `<env>` block is always emitted by pi-base via
 * `formatEnvBlock` so the model sees one consistent envelope regardless of body source.
 *
 * When we reuse upstream's prebuilt prompt as the body, we first strip its own trailing
 * date/cwd lines (`stripUpstreamEnvInfo`) so the final prompt has exactly one env section.
 */
function buildAgentSystemPrompt(options: BuildSystemPromptOptions, fallbackSystemPrompt: string): string {
  const customPrompt = options.customPrompt?.trim();
  const body = customPrompt
    ? buildCustomPromptBody(customPrompt, options)
    : stripUpstreamEnvInfo(fallbackSystemPrompt);
  if (!options.cwd) return body;
  return body + formatEnvBlock(options.cwd);
}

function buildCustomPromptBody(customPrompt: string, options: BuildSystemPromptOptions): string {
  const appendSection = options.appendSystemPrompt ? `\n\n${options.appendSystemPrompt}` : "";
  const contextFiles = options.contextFiles ?? [];
  const selectedTools = options.selectedTools;
  const skills = options.skills ?? [];

  let prompt = customPrompt;
  if (appendSection) {
    prompt += appendSection;
  }

  if (contextFiles.length > 0) {
    // Mirror upstream buildSystemPrompt's <project_context> envelope so all prompt sections
    // (skills, env, subagents, project context) share the same XML shape.
    prompt += "\n\n<project_context>\n\n";
    prompt += "Project-specific instructions and guidelines:\n\n";
    for (const { path: filePath, content } of contextFiles) {
      prompt += `<project_instructions path="${escapeXml(filePath)}">\n${escapeXml(content)}\n</project_instructions>\n\n`;
    }
    prompt += "</project_context>\n";
  }

  const customPromptHasRead = !selectedTools || selectedTools.includes("read");
  if (customPromptHasRead && skills.length > 0) {
    prompt += formatSkillsForPrompt(skills);
  }

  return prompt;
}

/**
 * Environment metadata block (date + cwd) appended to every system prompt. Matches opencode's
 * `<env>` XML envelope so the model can parse it the same way it parses `<available_skills>`
 * and the new `<available_subagents>` block. The two leading empty entries ensure a blank line
 * separates `<env>` from whatever precedes it (skills, custom prompt, etc.) regardless of
 * whether the body ends with a trailing newline.
 */
function formatEnvBlock(cwd: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const date = `${year}-${month}-${day}`;
  const normalizedCwd = cwd.replace(/\\/g, "/");
  return [
    "",
    "",
    "<env>",
    `  Current date: ${date}`,
    `  Current working directory: ${normalizedCwd}`,
    "</env>",
  ].join("\n");
}

/**
 * Upstream's `buildSystemPrompt` always appends two trailing lines to its output:
 *   `\nCurrent date: <date>\nCurrent working directory: <cwd>`
 * Strip them so `formatEnvBlock` can emit exactly one consistent `<env>` envelope at the end
 * of the final prompt. This is the only place we touch upstream's output structure, and the
 * intent (normalize body → then `formatEnvBlock` appends the envelope) is explicit.
 */
function stripUpstreamEnvInfo(prompt: string): string {
  return prompt.replace(/\nCurrent date: \S+\nCurrent working directory: \S+$/, "");
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

  filterUnknownSubagents(byName, diagnostics);

  agents.sort((left, right) => {
    if (left.name === DEFAULT_AGENT_NAME) return -1;
    if (right.name === DEFAULT_AGENT_NAME) return 1;
    return left.name.localeCompare(right.name);
  });

  return { agents, byName, diagnostics };
}

function filterUnknownSubagents(byName: Map<string, AgentDefinition>, diagnostics: string[]): void {
  const availableAgents = Array.from(byName.keys());
  for (const agent of byName.values()) {
    if (!agent.subagents?.length) continue;
    const validSubagents: string[] = [];
    const invalidSubagents: string[] = [];
    for (const subagentName of agent.subagents) {
      if (byName.has(subagentName)) validSubagents.push(subagentName);
      else invalidSubagents.push(subagentName);
    }
    if (invalidSubagents.length > 0) {
      const available = availableAgents.filter((name) => name !== agent.name).join(" / ") || "(no available agents)";
      diagnostics.push(
        `pi-base agent warning: agent "${agent.name}" declares unknown subagents [${invalidSubagents.join(", ")}]; available agents: ${available}. Ignoring the unknown entries.`,
      );
    }
    agent.subagents = validSubagents.length > 0 ? validSubagents : undefined;
  }
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
  const subagents = normalizeStringListField(frontmatter.subagents, "subagents", filePath);
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
    ...(subagents ? { subagents } : {}),
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

function normalizeStringListField(value: unknown, fieldName: "tools" | "skills" | "subagents", filePath: string): string[] | undefined {
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
