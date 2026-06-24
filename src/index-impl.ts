import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFindToolDefinition } from "./find-tool.js";
import { readFileSync } from "node:fs";
import { registerReadTool } from "./read.js";
import { registerEditTool } from "./edit.js";
import { registerGrepTool } from "./grep.js";
import { registerWriteTool } from "./write.js";
import { registerBashRendererTool } from "./bash-renderer.js";
import { type LoadedPiBaseSettings } from "./config.js";
import { registerPermissionGuard } from "./permission.js";
import { loadRuntimePiBaseSettings, reloadRuntimePiBaseSettings, toggleRuntimeYolo } from "./runtime-settings.js";
import { lspManager } from "./lsp/client.js";
import { registerLspTools, type LspResolverFactory } from "./lsp/tools.js";
import { LspDiscoveryResolver } from "./lsp/discovery.js";
import { applyUnifiedOutputTruncation } from "./tool-output.js";
import { findSchema } from "./schemas/find.js";
import { inferToolResultIsError } from "./tool-result.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";
import { formatOptionalArgs, renderCallText, renderRawResult, resolveCollapsedResultLines, resolveCollapsedResultMaxChars, resolveToolPatternValue, shortenHomePath, styleAccent, styleMuted, styleOutput, styleToolTitle, type CollapsedResultLinesResolver, type CollapsedResultMaxCharsResolver } from "./render.js";
import { applyContextCompressionToMessages, shouldApplyContextCompression } from "./context-compression.js";
import { applyAnthropicCompressionBoundaryCacheMarker } from "./anthropic-cache-boundary.js";
import { registerResumeAllCommand } from "./resume-all.js";
import { createTimeoutSignal, parsePositiveNumber } from "./timeout.js";
import { describeToolWorkdirForDisplay, resolveToolWorkdir } from "./path-utils.js";
import { registerMcpSupport, type RegisterMcpSupportOptions } from "./mcp/index.js";
import { registerNotifySupport, type RegisterNotifySupportOptions } from "./notify.js";
import { registerAgentSupport } from "./agent-support.js";
import { InMemorySnapshotStore } from "./hashline/index.js";
import { createNoopLoopGuard } from "./hashline-noop-guard.js";
export { LspDiscoveryResolver, type LspDiscoveryConfig, type LspSupportInfo, type LspServerConfig, type LspServerEntry } from "./lsp/discovery.js";
export { loadPiBaseSettings, type PermissionAction, type PermissionConfig, type PermissionRuleEntry, type PiBaseSettings, type RenderConfig, type CollapsedToolResultLinesConfig, type CollapsedToolResultMaxCharsConfig, type NotifyConfig, type YoloMode, type ContextCompressionConfig } from "./config.js";
export type { PiBaseNotifyKind, PiBaseNotifyPayload } from "./notify.js";
export type { LocalMcpServerConfig, McpConfig, McpRemoteTransport, McpServerConfig, McpSnapshot, McpToolSnapshot, RemoteMcpServerConfig } from "./mcp/types.js";

const BASE_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "bash",
  "edit",
  "write",
  "lsp_diagnostics",
  "lsp_goto_definition",
  "lsp_workspace_symbols",
  "lsp_java_decompile",
] as const;
const BASE_TOOL_GUIDE = readFileSync(new URL("../prompts/base.md", import.meta.url), "utf8").trim();

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
  pi.registerTool({
    ...template,
    parameters: findSchema,
    description: loadToolDescription("find"),
    promptSnippet: loadToolPromptSnippet("find"),
    renderCall(args: any, theme: any, context: any) {
      return renderCallText(formatFindCall(args, theme, context?.cwd), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("find", undefined, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("find", undefined, context, options.getCollapsedResultMaxChars);
      if (collapsedLines === undefined && maxCollapsedChars === undefined) {
        return template.renderResult ? template.renderResult(result, renderOptions, theme, context) : renderRawResult(result, renderOptions, theme, context);
      }
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
        const scopedParams = { ...params, path: rawPath };
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
  } as any);
}

export default function piBaseExtension(pi: ExtensionAPI, options: PiBaseExtensionOptions = {}): void {
  const loadSettings = loadRuntimePiBaseSettings;
  const resolverFactory = createResolverFactory(loadSettings);
  const getCollapsedResultLines = createCollapsedResultLinesResolver(loadSettings);
  const getCollapsedResultMaxChars = createCollapsedResultMaxCharsResolver(loadSettings);
  const snapshots = new InMemorySnapshotStore();
  const noopLoopGuard = createNoopLoopGuard();
  const syncLsp = (absolutePath: string) => {
    void lspManager.syncFileIfOpen(absolutePath).catch(() => undefined);
  };
  pi.on("session_start", async (event) => {
    if (event.reason === "reload") reloadRuntimePiBaseSettings();
    resolverFactory.clear();
    snapshots.clear();
    noopLoopGuard.entries.clear();
    await lspManager.shutdownAll();
    const activeTools = pi.getActiveTools();
    if (activeTools.length === 0) {
      pi.setActiveTools([...BASE_TOOL_NAMES]);
    } else if (activeTools.includes("task")) {
      const activeToolsWithoutRetiredTask = activeTools.filter((name) => name !== "task");
      pi.setActiveTools(activeToolsWithoutRetiredTask.length > 0 ? activeToolsWithoutRetiredTask : [...BASE_TOOL_NAMES]);
    }
  });

  registerReadTool(pi, {
    snapshots,
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
    snapshots,
    noopLoopGuard,
    getCollapsedResultLines,
    getCollapsedResultMaxChars,
    onSuccessfulEdit: (absolutePath) => { syncLsp(absolutePath); },
  });
  registerWriteTool(pi, {
    snapshots,
    onSuccessfulWrite: syncLsp,
    getCollapsedResultLines,
    getCollapsedResultMaxChars,
  });
  registerLspTools(pi, { resolverFactory, getCollapsedResultLines, getCollapsedResultMaxChars });
  const notifyHooks = registerNotifySupport(pi, {
    loadSettings,
    ...options.notify,
  });
  registerMcpSupport(pi, {
    loadSettings,
    getCollapsedResultLines,
    getCollapsedResultMaxChars,
    ...options.mcp,
  });
  registerPermissionGuard(pi, {
    loadSettings,
    toggleYolo: toggleRuntimeYolo,
    onPermissionAsked: notifyHooks.onPermissionAsked,
    onPermissionRejected: notifyHooks.onPermissionRejected,
  });
  registerAgentSupport(pi, { baseToolGuide: BASE_TOOL_GUIDE });
  registerResumeAllCommand(pi);


  (pi as any).on("context", async (event: any, ctx: ExtensionContext) => {
    if (!Array.isArray(event.messages)) return undefined;
    const compressionConfig = loadSettings(ctx.cwd).settings.contextCompression;
    if (!shouldApplyContextCompression(compressionConfig, ctx.model?.provider)) return undefined;
    const messages = applyContextCompressionToMessages(event.messages, ctx.cwd, compressionConfig, { systemPrompt: ctx.getSystemPrompt?.() });
    return messages === event.messages ? undefined : { messages };
  });
  (pi as any).on("before_provider_payload", async (event: any) => {
    if (!applyAnthropicCompressionBoundaryCacheMarker(event.payload)) return undefined;
    return { payload: event.payload };
  });

  // Global output guard: applies to every tool result that flows through Pi, including third-party tools.
  pi.on("tool_result", async (event, ctx: any = {}) => {
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
