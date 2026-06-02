import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFindToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { registerReadTool } from "./src/read.js";
import { registerEditTool } from "./src/edit.js";
import { registerGrepTool } from "./src/grep.js";
import { registerWriteTool } from "./src/write.js";
import { registerBashRendererTool } from "./src/bash-renderer.js";
import { loadPiBaseSettings } from "./src/config.js";
import { lspManager } from "./src/lsp/client.js";
import { registerLspTools, type LspResolverFactory } from "./src/lsp/tools.js";
import { LspDiscoveryResolver } from "./src/lsp/discovery.js";
import { applyUnifiedOutputTruncation } from "./src/tool-output.js";
import { findSchema } from "./src/schemas/find.js";
import { inferToolResultIsError } from "./src/tool-result.js";
export { LspDiscoveryResolver, type LspDiscoveryConfig, type LspSupportInfo, type LspServerConfig, type LspServerEntry } from "./src/lsp/discovery.js";
export { loadPiBaseSettings, type PiBaseSettings } from "./src/config.js";

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

function createResolverFactory(): LspResolverFactory {
  const cache = new Map<string, LspDiscoveryResolver>();
  return (cwd: string) => {
    const cached = cache.get(cwd);
    if (cached) return cached;
    const loaded = loadPiBaseSettings(cwd);
    const resolver = new LspDiscoveryResolver(loaded.settings.lsp ?? {});
    cache.set(cwd, resolver);
    return resolver;
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
export function registerFindTool(pi: ExtensionAPI, createToolDefinition: FindToolDefinitionFactory = createFindToolDefinition): void {
  const template = createToolDefinition(process.cwd());
  pi.registerTool({
    ...template,
    parameters: findSchema,
    description: "Search for files by glob pattern. `path` is required — there is no implicit search root. Use `.` for the current working directory. Respects .gitignore.",
    promptSnippet: "Find files by glob pattern in an explicit path (`path` required)",
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
  const resolverFactory = createResolverFactory();
  const filesWithFreshAnchors = new Set<string>();
  const cachedFileLines = new Map<string, string[]>();
  const noteAnchorsAndSnapshot = (absolutePath: string, lines?: string[]) => {
    filesWithFreshAnchors.add(absolutePath);
    if (lines) cachedFileLines.set(absolutePath, lines);
  };
  const hasFreshAnchors = (absolutePath: string) => filesWithFreshAnchors.has(absolutePath);
  const getCachedLines = (absolutePath: string) => cachedFileLines.get(absolutePath);
  const syncLsp = (absolutePath: string) => {
    void lspManager.syncFileIfOpen(absolutePath).catch(() => undefined);
  };

  registerReadTool(pi, { onSuccessfulRead: noteAnchorsAndSnapshot, createResolver: resolverFactory });
  registerGrepTool(pi, { onFileAnchored: noteAnchorsAndSnapshot });
  // Delegate `find` to the built-in pi-coding-agent tool, which uses `fd` directly,
  // respects `.gitignore` (rg/fd default), and auto-downloads `fd` if missing.
  // This keeps `pi-base` thin and lets upstream handle fd behavior.
  registerFindTool(pi);
  registerBashRendererTool(pi);
  registerEditTool(pi, { wasReadInSession: hasFreshAnchors, getCachedLines, onSuccessfulEdit: (absolutePath, lines) => { noteAnchorsAndSnapshot(absolutePath, lines); syncLsp(absolutePath); } });
  registerWriteTool(pi, { onFileAnchored: noteAnchorsAndSnapshot, onSuccessfulWrite: syncLsp });
  registerLspTools(pi, { resolverFactory });

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
