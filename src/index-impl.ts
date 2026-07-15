import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFindToolDefinition } from "./find-tool.js";
import { readFileSync } from "node:fs";
import { registerReadTool } from "./read.js";
import { registerEditTool } from "./edit.js";
import { registerGrepTool } from "./grep.js";
import { registerWriteTool } from "./write.js";
import { registerApplyPatchTool } from "./apply-patch.js";
import { registerBashRendererTool } from "./bash-renderer.js";
import { type LoadedPiBaseSettings } from "./config.js";
import { registerPermissionGuard, truncatePermissionLine } from "./permission.js";
import { loadRuntimePiBaseSettings, reloadRuntimePiBaseSettings, toggleRuntimeYolo } from "./runtime-settings.js";
import { lspManager } from "./lsp/client.js";
import { registerLspTools, type LspResolverFactory } from "./lsp/tools.js";
import { LspDiscoveryResolver } from "./lsp/discovery.js";
import { applyUnifiedOutputTruncation } from "./tool-output.js";
import { mapFilePathToPath } from "./tool-arg-aliases.js";
import { findSchema } from "./schemas/find.js";
import { inferToolResultIsError } from "./tool-result.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";
import { formatOptionalArgs, renderStreamingCallText, renderRawResult, resolveCollapsedResultLines, resolveCollapsedResultMaxChars, resolveToolPatternValue, shortenHomePath, styleAccent, styleMuted, styleOutput, styleToolTitle, type CollapsedResultLinesResolver, type CollapsedResultMaxCharsResolver } from "./render.js";
import { applyContextCompressionToMessages, shouldApplyContextCompression } from "./context-compression.js";
import { applyAnthropicCompressionBoundaryCacheMarker } from "./anthropic-cache-boundary.js";
import { registerResumeAllCommand } from "./resume-all.js";
import { createTimeoutSignal, parsePositiveNumber } from "./timeout.js";
import { withPiBaseErrorMarker } from "./tool-error-marker.js";
import { describeToolWorkdirForDisplay, resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import { registerMcpSupport, type RegisterMcpSupportOptions } from "./mcp/index.js";
import { registerNotifySupport, type RegisterNotifySupportOptions } from "./notify.js";
import { registerAgentSupport } from "./agent-support.js";
import { TASK_TOOL_NAME } from "./subagent/constants.js";
import { resolveSubagentConfig } from "./subagent/config.js";
import { isRootSession, readDepth, readRootSessionId, ROOT_DEPTH } from "./subagent/depth.js";
import {
  clearSubagentPermissionHost,
  setSubagentPermissionHost,
  type SubagentPermissionHost,
} from "./subagent/permission-host.js";
import { createRealSubagentFactory } from "./subagent/runner.js";
import { subagentRegistry } from "./subagent/registry.js";
import { createSubagentWidgetComponent, renderSubagentWidget, SUBAGENT_WIDGET_KEY } from "./subagent/widget.js";
import { registerSubagentTaskTool } from "./subagent/task-tool.js";
import { registerSubagentCommand } from "./subagent/command.js";
import { projectFileMutationTools } from "./model-tool-routing.js";
export { LspDiscoveryResolver, type LspDiscoveryConfig, type LspSupportInfo, type LspServerConfig, type LspServerEntry, type LspWorkspaceDataConfig, type LspWorkspaceDataMode } from "./lsp/discovery.js";
export { loadPiBaseSettings, type PermissionAction, type PermissionConfig, type PermissionRuleEntry, type PiBaseSettings, type RenderConfig, type CollapsedToolResultLinesConfig, type CollapsedToolResultMaxCharsConfig, type NotifyConfig, type YoloMode, type ContextCompressionConfig, type SubagentConfig } from "./config.js";
export type { PiBaseNotifyKind, PiBaseNotifyPayload } from "./notify.js";
export type { LocalMcpServerConfig, McpConfig, McpRemoteTransport, McpServerConfig, McpSnapshot, McpToolSnapshot, RemoteMcpServerConfig } from "./mcp/types.js";

const BASE_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "bash",
  "edit",
  "write",
  "apply_patch",
  // "lsp_diagnostics", // Disabled for 0.1.x evaluation; restore or remove before the next minor release.
  "lsp_goto_definition",
  "lsp_workspace_symbols",
  "lsp_java_decompile",
] as const;
const BASE_TOOL_GUIDE = readFileSync(new URL("../prompts/base.md", import.meta.url), "utf8").trim();

type RegisteredToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

function isBuiltinTool(tool: RegisteredToolInfo): boolean {
  return tool.sourceInfo?.source === "builtin";
}

function resolveBuiltinToolNames(pi: Pick<ExtensionAPI, "getAllTools">): ReadonlySet<string> {
  return new Set(pi.getAllTools().filter(isBuiltinTool).map((tool) => tool.name));
}

export interface PiBaseExtensionOptions {
  mcp?: RegisterMcpSupportOptions;
  notify?: RegisterNotifySupportOptions;
}


type CachedLspResolverFactory = LspResolverFactory & { clear: () => void };
function createResolverFactory(loadSettings: (cwd: string) => LoadedPiBaseSettings): CachedLspResolverFactory {
  const cache = new Map<string, LspDiscoveryResolver>();
  const create = ((cwd: string) => {
    const cached = cache.get(cwd);
    if (cached) return cached;
    const loaded = loadSettings(cwd);
    const resolver = new LspDiscoveryResolver(loaded.settings.lsp ?? {});
    cache.set(cwd, resolver);
    return resolver;
  }) as CachedLspResolverFactory;
  create.clear = () => cache.clear();
  return create;
}

function createCollapsedResultLinesResolver(loadSettings: (cwd: string) => LoadedPiBaseSettings): CollapsedResultLinesResolver {
  return (cwd: string, toolName: string) => {
    const config = loadSettings(cwd).settings.render?.collapsedToolResultLines;
    return resolveToolPatternValue(config, toolName);
  };
}
function createCollapsedResultMaxCharsResolver(loadSettings: (cwd: string) => LoadedPiBaseSettings): CollapsedResultMaxCharsResolver {
  return (cwd: string, toolName: string) => {
    const config = loadSettings(cwd).settings.render?.collapsedToolResultMaxChars;
    return resolveToolPatternValue(config, toolName);
  };
}

type FindToolDefinitionFactory = (cwd: string) => any;
function formatFindCall(args: any, theme: any, cwd?: string): string {
  const pattern = String(args?.pattern ?? "<missing-pattern>");
  const path = shortenHomePath(String(args?.path ?? "<missing-path>"));
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleMuted(theme, " from ")}${styleAccent(theme, shortenHomePath(rawWorkdir))}`;
  const suffix = formatOptionalArgs([
    ["limit", args?.limit],
    ["timeout_seconds", args?.timeout_seconds],
  ]);
  return `${styleToolTitle(theme, "find")} ${styleOutput(theme, pattern)} ${styleMuted(theme, "in")} ${styleAccent(theme, path)}${workdir}${styleOutput(theme, suffix)}`;
}

/**
 * Wrap upstream's `find` so that `path` is required.
 *
 * Two layers of enforcement, by design:
 * 1. Schema: we override `parameters` with `findSchema` (path is a non-optional
 *    string), so the model sees a required field in its tool description.
 * 2. Runtime: we re-check `params.path` in `execute` and return `isError: true`
 *    if it is missing or empty. The schema is the contract; the runtime check
 *    is defense in depth in case the model bypasses schema validation.
 *
 * `path` resolution defaults to the session `ctx.cwd`. If `workdir` is provided,
 * resolution uses that directory instead. Callers should pass `workdir` whenever
 * they intend to search outside the current workspace root.
 */
export function registerFindTool(
  pi: ExtensionAPI,
  createToolDefinition: FindToolDefinitionFactory = createFindToolDefinition,
  options: { getCollapsedResultLines?: CollapsedResultLinesResolver; getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver } = {},
): void {
  const template = createToolDefinition(process.cwd());
  const tool = withPiBaseErrorMarker({
    ...template,
    prepareArguments(args: unknown) {
      return mapFilePathToPath(args);
    },
    parameters: findSchema,
    description: loadToolDescription("find"),
    promptSnippet: loadToolPromptSnippet("find"),
    renderCall(args: any, theme: any, context: any) {
      const mappedArgs = mapFilePathToPath(args);
      return renderStreamingCallText(formatFindCall(mappedArgs, theme, context?.cwd), theme, context);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("find", undefined, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("find", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(result, { ...renderOptions, collapsedLines, maxCollapsedChars }, theme, context);
    },
    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any = {}) {
      const rawPath = typeof params?.path === "string" ? params.path.trim() : "";
      if (!rawPath) {
        return {
          content: [{
            type: "text" as const,
            text: "Error: find requires an explicit `path` argument. Specify the directory to search in (use \".\" for the current working directory).",
          }],
          isError: true,
        };
      }
      try {
        const { cwd } = resolveToolWorkdir(params.workdir, ctx.cwd ?? process.cwd());
        const scopedTool = createToolDefinition(cwd);
        const timeoutSeconds = params.timeout_seconds === undefined ? undefined : parsePositiveNumber(params.timeout_seconds, "timeout_seconds", 1);
        const scopedParams = { ...params, path: resolveToCwd(rawPath, cwd) };
        delete scopedParams.workdir;
        delete scopedParams.timeout_seconds;
        if (timeoutSeconds === undefined) return scopedTool.execute(toolCallId, scopedParams, signal, onUpdate, ctx);
        const timeout = createTimeoutSignal(signal, timeoutSeconds);
        try {
          return await scopedTool.execute(toolCallId, scopedParams, timeout.signal, onUpdate, ctx);
        } catch (error) {
          if (timeout.didTimeout()) {
            return {
              content: [{
                type: "text" as const,
                text: `Error: find timed out after ${timeoutSeconds}s.\nHint: Narrow the path or pattern first. If a broad scan is truly necessary, rerun find with a larger timeout_seconds value.`,
              }],
              isError: true,
            };
          }
          throw error;
        } finally {
          timeout.cleanup();
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  });
  pi.registerTool(tool as any);
}

export default function piBaseExtension(pi: ExtensionAPI, options: PiBaseExtensionOptions = {}): void {
  const loadSettings = loadRuntimePiBaseSettings;
  const resolverFactory = createResolverFactory(loadSettings);
  const getCollapsedResultLines = createCollapsedResultLinesResolver(loadSettings);
  const getCollapsedResultMaxChars = createCollapsedResultMaxCharsResolver(loadSettings);
  const syncLsp = (absolutePath: string) => {
    void lspManager.syncFileIfOpen(absolutePath).catch(() => undefined);
  };
  const closeLsp = (absolutePath: string) => {
    void lspManager.closeFileIfOpen(absolutePath).catch(() => undefined);
  };
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "reload") {
      reloadRuntimePiBaseSettings();
      resolverFactory.clear();
      if (isRootSession(ctx)) await lspManager.shutdownAll();
    } else {
      resolverFactory.clear();
    }
    const activeTools = pi.getActiveTools();
    const defaultTools = projectFileMutationTools(BASE_TOOL_NAMES, ctx.model?.id, "implicit");
    if (activeTools.length === 0) {
      pi.setActiveTools(defaultTools);
      return;
    }

    // pi-base replaces Pi's built-in tool set. Keep extension/SDK/MCP tools, but
    // remove final registry entries that still come from the built-in source.
    // `task` is an extension tool and is handled separately: agent-support
    // re-injects it only for agents that may delegate.
    const builtinToolNames = resolveBuiltinToolNames(pi);
    const withoutBuiltins = activeTools.filter((name) => !builtinToolNames.has(name));
    const withoutTask = withoutBuiltins.filter((name) => name !== TASK_TOOL_NAME);
    const preservedTools = withoutBuiltins.includes(TASK_TOOL_NAME)
      ? (withoutTask.length > 0 ? withoutTask : defaultTools)
      : withoutBuiltins;
    const nextTools = projectFileMutationTools(preservedTools, ctx.model?.id, "implicit");
    if (nextTools.length !== activeTools.length || nextTools.some((name, index) => name !== activeTools[index])) {
      pi.setActiveTools(nextTools);
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    resolverFactory.clear();
    // The process-wide manager is owned by the single active root session; headless subagents must
    // not shut down clients shared with that root.
    if (isRootSession(ctx)) await lspManager.shutdownAll();
  });

  registerReadTool(pi, {
    createResolver: resolverFactory,
    getCollapsedResultLines,
    getCollapsedResultMaxChars,
  });
  registerGrepTool(pi, { getCollapsedResultLines, getCollapsedResultMaxChars });
  // `find` uses the same `fd` backend as pi-coding-agent, but pi-base owns the
  // child-process termination strategy so timeout/abort handling is consistent
  // with the local grep/bash wrappers.
  registerFindTool(pi, createFindToolDefinition, { getCollapsedResultLines, getCollapsedResultMaxChars });
  registerBashRendererTool(pi, { getCollapsedResultLines, getCollapsedResultMaxChars });
  registerEditTool(pi, {
    getCollapsedResultLines,
    getCollapsedResultMaxChars,
    onSuccessfulEdit: (absolutePath) => { syncLsp(absolutePath); },
  });
  registerWriteTool(pi, {
    onSuccessfulWrite: syncLsp,
    getCollapsedResultLines,
    getCollapsedResultMaxChars,
  });
  registerApplyPatchTool(pi, {
    onCommitted: (result) => {
      if (result.operation === "delete") closeLsp(result.absolutePath);
      else syncLsp(result.absolutePath);
    },
    onCommitFailed: (failure) => {
      closeLsp(failure.absolutePath);
    },
    getCollapsedResultLines,
    getCollapsedResultMaxChars,
  });
  registerLspTools(pi, { resolverFactory, getCollapsedResultLines, getCollapsedResultMaxChars });
  const notifyHooks = registerNotifySupport(pi, {
    loadSettings,
    ...options.notify,
  });
  const subagentControls = {
    taskToolName: TASK_TOOL_NAME,
    getMaxDepth: (cwd: string) => resolveSubagentConfig(loadSettings(cwd)).maxDepth,
    readDepth,
  };
  const inactiveDynamicToolNames = new Set<string>();
  pi.registerFlag("agent", {
    type: "string",
    description: "Start in a specific pi-base agent by name (e.g. --agent reviewer). Ignored if the resumed session already has an agent.",
  });
  const agentHandle = registerAgentSupport(pi, {
    baseToolGuide: BASE_TOOL_GUIDE,
    subagentControls,
    getStartupAgentName: () => {
      const value = pi.getFlag("agent");
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },
    getConfiguredDefaultAgentName: (cwd: string) => loadSettings(cwd).settings.defaultAgent,
    isToolActivatable: (tool) =>
      !isBuiltinTool(tool) && !inactiveDynamicToolNames.has(tool.name),
  });
  registerMcpSupport(pi, {
    ...options.mcp,
    loadSettings,
    getCollapsedResultLines,
    getCollapsedResultMaxChars,
    canActivateTool: (toolName: string) =>
      agentHandle.canActivateTool(toolName) && (options.mcp?.canActivateTool?.(toolName) ?? true),
    onToolAvailabilityChange: (toolName: string, available: boolean) => {
      if (available) inactiveDynamicToolNames.delete(toolName);
      else inactiveDynamicToolNames.add(toolName);
      options.mcp?.onToolAvailabilityChange?.(toolName, available);
    },
  });
  registerSubagentTaskTool(pi, {
    getActiveAgentSubagents: agentHandle.getActiveAgentSubagents,
    hasAgent: agentHandle.hasAgent,
    getMaxConcurrency: (cwd: string) => resolveSubagentConfig(loadSettings(cwd)).maxConcurrency,
    getMaxTotalConcurrency: (cwd: string) => resolveSubagentConfig(loadSettings(cwd)).maxTotalConcurrency,
    getIdleTimeoutMs: (cwd: string) => resolveSubagentConfig(loadSettings(cwd)).idleTimeoutMs,
    getMaxTurns: (cwd: string) => resolveSubagentConfig(loadSettings(cwd)).maxTurns,
    getCollapsedResultLines,
    getCollapsedResultMaxChars,
    factory: createRealSubagentFactory({
      resolveAgentRuntimeConfig: agentHandle.resolveAgentRuntimeConfig,
    }),
  });
  registerPermissionGuard(pi, {
    loadSettings,
    toggleYolo: toggleRuntimeYolo,
    onPermissionAsked: notifyHooks.onPermissionAsked,
    onPermissionRejected: notifyHooks.onPermissionRejected,
    resolveSubagentInfo: (ctx) => {
      const depth = readDepth(ctx);
      if (depth <= ROOT_DEPTH) return undefined;
      return { agentType: agentHandle.getActiveAgentName(), depth, rootSessionId: readRootSessionId(ctx) };
    },
  });
  registerResumeAllCommand(pi);
  registerSubagentCommand(pi);

  // Only the root (UI-owning) session hosts subagent permission prompts. Headless subagent
  // sessions relay their `ask` prompts here via the module-level permission host. The same root
  // also owns the live subagent tree widget.
  let registeredHost: SubagentPermissionHost | null = null;
  let registeredHostRootSessionId: string | null = null;
  let hostChain: Promise<unknown> = Promise.resolve();
  let unsubscribeWidget: (() => void) | null = null;
  let widgetRenderTimer: ReturnType<typeof setTimeout> | null = null;
  pi.on("session_start", async (_event, ctx?: ExtensionContext) => {
    if (!ctx?.hasUI || !isRootSession(ctx)) return;
    if (registeredHost) {
      if (registeredHostRootSessionId === null) clearSubagentPermissionHost(registeredHost);
      else clearSubagentPermissionHost(registeredHostRootSessionId, registeredHost);
      registeredHost = null;
      registeredHostRootSessionId = null;
    }
    const rootSessionId = readRootSessionId(ctx);
    const host: SubagentPermissionHost = async (req) => {
      const run = hostChain.then(async () => {
        if (registeredHost !== host || registeredHostRootSessionId !== rootSessionId) {
          throw new Error("Subagent permission host is no longer active");
        }
        if (req.signal?.aborted) throw new Error("Operation aborted");
        await notifyHooks.onPermissionAsked({ ctx });
        if (req.signal?.aborted) throw new Error("Operation aborted");
        const summary = req.prompt.replace(/^Permission request:\s*/i, "");
        const title = truncatePermissionLine(`⟳ subagent「${req.agentType}」(depth ${req.depth}) requests permission: ${summary}`);
        const choice = await ctx.ui.select(title, ["Yes", "No"]);
        if (registeredHost !== host || registeredHostRootSessionId !== rootSessionId) {
          throw new Error("Subagent permission host is no longer active");
        }
        if (req.signal?.aborted) throw new Error("Operation aborted");
        if (choice !== "Yes") notifyHooks.onPermissionRejected({ ctx });
        return choice === "Yes";
      });
      hostChain = run.catch(() => undefined);
      return run;
    };
    registeredHost = host;
    registeredHostRootSessionId = rootSessionId;
    setSubagentPermissionHost(rootSessionId, host);

    // Live subagent tree widget: re-render (throttled) whenever the registry changes, so parallel
    // and nested delegation is visible while a `task` call blocks the parent turn.
    if (unsubscribeWidget) unsubscribeWidget();
    if (widgetRenderTimer) {
      clearTimeout(widgetRenderTimer);
      widgetRenderTimer = null;
    }
    const render = () => {
      widgetRenderTimer = null;
      const nodes = subagentRegistry.forRoot(rootSessionId);
      const visible = renderSubagentWidget(nodes, rootSessionId);
      ctx.ui.setWidget(
        SUBAGENT_WIDGET_KEY,
        visible ? () => createSubagentWidgetComponent(nodes, rootSessionId) : undefined,
      );
    };
    const scheduleRender = () => {
      if (widgetRenderTimer) return;
      widgetRenderTimer = setTimeout(render, 50);
    };
    render();
    unsubscribeWidget = subagentRegistry.onChange(scheduleRender);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const shutdownRootSessionId = isRootSession(ctx) ? readRootSessionId(ctx) : null;
    const ownsRegisteredUi = shutdownRootSessionId !== null
      && registeredHostRootSessionId === shutdownRootSessionId;
    if (registeredHost && ownsRegisteredUi) {
      clearSubagentPermissionHost(shutdownRootSessionId, registeredHost);
      registeredHost = null;
      registeredHostRootSessionId = null;
    }
    if (ownsRegisteredUi && unsubscribeWidget) {
      unsubscribeWidget();
      unsubscribeWidget = null;
    }
    if (ownsRegisteredUi && widgetRenderTimer) {
      clearTimeout(widgetRenderTimer);
      widgetRenderTimer = null;
    }
    if (shutdownRootSessionId !== null) {
      subagentRegistry.removeForRoot(shutdownRootSessionId);
      if (ownsRegisteredUi && ctx.hasUI) ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
    }
  });

  pi.on("context", async (event, ctx) => {
    if (!Array.isArray(event.messages)) return undefined;
    const compressionConfig = loadSettings(ctx.cwd).settings.contextCompression;
    if (!shouldApplyContextCompression(compressionConfig, ctx.model?.provider)) return undefined;
    const messages = applyContextCompressionToMessages(event.messages, ctx.cwd, compressionConfig, { systemPrompt: ctx.getSystemPrompt?.() });
    return messages === event.messages ? undefined : { messages };
  });
  pi.on("before_provider_request", async (event) => {
    if (!applyAnthropicCompressionBoundaryCacheMarker(event.payload)) return undefined;
    return event.payload;
  });

  // Global output guard: applies to every tool result that flows through Pi, including third-party tools.
  pi.on("tool_result", async (event) => {
    const original = {
      content: event.content,
      details: event.details,
      ...(event.isError ? { isError: true as const } : {}),
    };
    const nextIsError = inferToolResultIsError(event.toolName, original as any);
    const truncated = await applyUnifiedOutputTruncation(event.toolName, original as any);
    const isErrorChanged = Boolean(event.isError) !== nextIsError;
    if (!truncated.truncated && !isErrorChanged) return undefined;
    return {
      content: truncated.result.content,
      details: truncated.result.details,
      ...(nextIsError ? { isError: true } : {}),
    };
  });

}
