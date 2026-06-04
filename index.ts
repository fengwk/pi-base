import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFindToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { registerReadTool } from "./src/read.js";
import { registerEditTool } from "./src/edit.js";
import { registerGrepTool } from "./src/grep.js";
import { registerWriteTool } from "./src/write.js";
import { registerBashRendererTool } from "./src/bash-renderer.js";
import { loadPiBaseSettings, type LoadedPiBaseSettings } from "./src/config.js";
import { registerPermissionGuard } from "./src/permission.js";
import { lspManager } from "./src/lsp/client.js";
import { registerLspTools, type LspResolverFactory } from "./src/lsp/tools.js";
import { LspDiscoveryResolver } from "./src/lsp/discovery.js";
import { applyUnifiedOutputTruncation } from "./src/tool-output.js";
import { findSchema } from "./src/schemas/find.js";
import { inferToolResultIsError } from "./src/tool-result.js";
import { loadToolDescription, loadToolPromptSnippet } from "./src/tool-prompt.js";
import { renderRawResult, resolveCollapsedResultLines, type CollapsedResultLinesResolver } from "./src/render.js";
import { applyContextCompressionToMessages } from "./src/context-compression.js";
import { applyAnthropicCompressionBoundaryCacheMarker } from "./src/anthropic-cache-boundary.js";
import { registerResumeAllCommand } from "./src/resume-all.js";
export { LspDiscoveryResolver, type LspDiscoveryConfig, type LspSupportInfo, type LspServerConfig, type LspServerEntry } from "./src/lsp/discovery.js";
export { loadPiBaseSettings, type PermissionAction, type PermissionConfig, type PermissionRuleEntry, type PiBaseSettings, type RenderConfig, type CollapsedToolResultLinesConfig, type YoloMode, type ContextCompressionConfig } from "./src/config.js";

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


function loadBaseToolGuide(): string {
  return readFileSync(new URL("./prompts/base.md", import.meta.url), "utf8").trim();
}

function createSettingsLoader(): (cwd: string) => LoadedPiBaseSettings {
  const cache = new Map<string, LoadedPiBaseSettings>();
  return (cwd: string) => {
    const cached = cache.get(cwd);
    if (cached) return cached;
    const loaded = loadPiBaseSettings(cwd);
    cache.set(cwd, loaded);
    return loaded;
  };
}

function createResolverFactory(loadSettings: (cwd: string) => LoadedPiBaseSettings): LspResolverFactory {
  const cache = new Map<string, LspDiscoveryResolver>();
  return (cwd: string) => {
    const cached = cache.get(cwd);
    if (cached) return cached;
    const loaded = loadSettings(cwd);
    const resolver = new LspDiscoveryResolver(loaded.settings.lsp ?? {});
    cache.set(cwd, resolver);
    return resolver;
  };
}

function createCollapsedResultLinesResolver(loadSettings: (cwd: string) => LoadedPiBaseSettings): CollapsedResultLinesResolver {
  return (cwd: string, toolName: string) => {
    const config = loadSettings(cwd).settings.render?.collapsedToolResultLines;
    if (config === undefined) return undefined;
    if (typeof config === "number") return config;
    return config[toolName] ?? config["*"];
  };
}

type FindToolDefinitionFactory = (cwd: string) => any;

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
 * `path` resolution still uses `ctx.cwd` per execution (not the extension's
 * `process.cwd()`), so a call from a different session cwd searches the right
 * tree.
 */
export function registerFindTool(
  pi: ExtensionAPI,
  createToolDefinition: FindToolDefinitionFactory = createFindToolDefinition,
  options: { getCollapsedResultLines?: CollapsedResultLinesResolver } = {},
): void {
  const template = createToolDefinition(process.cwd());
  pi.registerTool({
    ...template,
    parameters: findSchema,
    description: loadToolDescription("find"),
    promptSnippet: loadToolPromptSnippet("find"),
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("find", undefined, context, options.getCollapsedResultLines);
      if (collapsedLines === undefined) {
        return template.renderResult ? template.renderResult(result, renderOptions, theme, context) : renderRawResult(result, renderOptions, theme, context);
      }
      return renderRawResult(result, { ...renderOptions, collapsedLines }, theme, context);
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
      const cwd = ctx.cwd ?? process.cwd();
      const scopedTool = createToolDefinition(cwd);
      return scopedTool.execute(toolCallId, { ...params, path: rawPath }, signal, onUpdate, ctx);
    },
  } as any);
}

export default function piBaseExtension(pi: ExtensionAPI): void {
  const loadSettings = createSettingsLoader();
  const resolverFactory = createResolverFactory(loadSettings);
  const getCollapsedResultLines = createCollapsedResultLinesResolver(loadSettings);
  const filesWithFreshAnchors = new Set<string>();
  const cachedFileLines = new Map<string, string[]>();
  const noteAnchorsAndSnapshot = (absolutePath: string, lines?: string[]) => {
    filesWithFreshAnchors.add(absolutePath);
    if (lines) cachedFileLines.set(absolutePath, [...lines]);
  };
  const hasFreshAnchors = (absolutePath: string) => filesWithFreshAnchors.has(absolutePath);
  const getCachedLines = (absolutePath: string) => cachedFileLines.get(absolutePath);
  const syncLsp = (absolutePath: string) => {
    void lspManager.syncFileIfOpen(absolutePath).catch(() => undefined);
  };

  registerReadTool(pi, { onSuccessfulRead: noteAnchorsAndSnapshot, createResolver: resolverFactory, getCollapsedResultLines });
  registerGrepTool(pi, { getCollapsedResultLines });
  // Delegate `find` to the built-in pi-coding-agent tool, which uses `fd` directly,
  // respects `.gitignore` (rg/fd default), and auto-downloads `fd` if missing.
  // This keeps `pi-base` thin and lets upstream handle fd behavior.
  registerFindTool(pi, createFindToolDefinition, { getCollapsedResultLines });
  registerBashRendererTool(pi, { getCollapsedResultLines });
  registerEditTool(pi, { wasReadInSession: hasFreshAnchors, getCachedLines, getCollapsedResultLines, onSuccessfulEdit: (absolutePath, lines) => { noteAnchorsAndSnapshot(absolutePath, lines); syncLsp(absolutePath); } });
  registerWriteTool(pi, { onFileAnchored: noteAnchorsAndSnapshot, onSuccessfulWrite: syncLsp, getCollapsedResultLines });
  registerLspTools(pi, { resolverFactory, getCollapsedResultLines });
  registerPermissionGuard(pi, { loadSettings });
  registerResumeAllCommand(pi);


  (pi as any).on("context", async (event: any, ctx: ExtensionContext) => {
    if (!Array.isArray(event.messages)) return undefined;
    const messages = applyContextCompressionToMessages(event.messages, ctx.cwd, loadSettings(ctx.cwd).settings.contextCompression, { systemPrompt: ctx.getSystemPrompt?.() });
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

  pi.on("session_start", async () => {
    if (pi.getActiveTools().length === 0) {
      pi.setActiveTools([...BASE_TOOL_NAMES]);
    }
  });

  pi.on("before_agent_start", async (event) => {
    const guide = loadBaseToolGuide();
    if (!guide) return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${guide}`,
    };
  });
}
