import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type CollapsedResultLinesResolver, type CollapsedResultMaxCharsResolver, formatInlineValue, formatOptionalArgs, renderCallText, renderRawResult, resolveCollapsedResultLines, resolveCollapsedResultMaxChars, shortenHomePath, styleAccent, styleOutput, styleToolTitle } from "../render.js";
import { lspDiagnosticsSchema, lspGotoDefinitionSchema, lspJavaDecompileSchema, lspWorkspaceSymbolsSchema } from "../schemas/lsp.js";
import { loadToolDescription, loadToolPromptSnippet } from "../tool-prompt.js";
import { resolveToCwd, resolveToolWorkdir } from "../path-utils.js";
import { LspDiscoveryResolver } from "./discovery.js";
import { lspManager } from "./client.js";

const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

/**
 * Resolve a possibly `file://` or `jdt://` URI to a local absolute path when
 * appropriate; otherwise resolve non-URI paths against the provided cwd. LSP
 * tools accept file URIs so users can pipe results from `lsp_java_decompile`
 * (which returns `jdt://` URIs) without manual unwrapping.
 */
function resolveFromCwd(filePath: string, cwd: string): string {
  if (filePath.startsWith("jdt://")) return filePath;
  if (filePath.startsWith("file://")) return fileURLToPath(filePath);
  return resolveToCwd(filePath, cwd);
}

/** Extract the first `jdt://` URI from a free-form string, or the whole string if none. */
function extractJdtUri(target: string): string | null {
  const idx = target.indexOf("jdt://");
  return idx === -1 ? null : target.slice(idx);
}

function formatDiagnostics(items: any[]): string {
  if (items.length === 0) return "No diagnostics found";
  return items
    .map((item) => {
      const severityName = (item.severity != null) ? ([, "error", "warning", "information", "hint"][item.severity] ?? `severity ${item.severity}`) : "info";
      const source = item.source ? ` [${item.source}${item.code ? ` ${item.code}` : ""}]` : "";
      return `${(item.range?.start?.line ?? 0) + 1}:${(item.range?.start?.character ?? 0)} ${severityName}${source} ${item.message}`;
    })
    .join("\n");
}

function formatLocations(result: any): string {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  if (list.length === 0) return "No results found";
  return list
    .map((location: any) => {
      const uri = location.uri ?? location.targetUri;
      const range = location.range ?? location.targetSelectionRange ?? location.targetRange;
      if (typeof uri === "string" && uri.startsWith("jdt://")) return uri;
      if (typeof uri === "string" && uri.startsWith("file://")) {
        return `${fileURLToPath(uri)}:${(range?.start?.line ?? 0) + 1}:${range?.start?.character ?? 0}`;
      }
      return `${uri}:${(range?.start?.line ?? 0) + 1}:${range?.start?.character ?? 0}`;
    })
    .join("\n");
}

function formatWorkspaceSymbols(result: any, limit: number): string {
  const list = Array.isArray(result) ? result.slice(0, limit) : [];
  if (list.length === 0) return "No symbols found";
  return list
    .map((symbol: any) => `${symbol.name} (${SYMBOL_KIND_NAMES[symbol.kind] ?? `kind ${symbol.kind}`}) - ${symbol.location?.uri ?? symbol.uri ?? "unknown"}`)
    .join("\n");
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer.`);
  return Number(value);
}

function requireNonNegativeInteger(value: unknown, name: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${name} must be a non-negative integer.`);
  return Number(value);
}

function abortError(): Error {
  return new Error("Operation aborted");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function formatWorkdirSuffix(args: any, theme: any): string {
  if (args?.workdir === undefined) return `${styleOutput(theme, " in ")}${styleAccent(theme, "<missing-workdir>")}`;
  return `${styleOutput(theme, " in ")}${styleAccent(theme, shortenHomePath(String(args.workdir)))}`;
}

function formatLspDiagnosticsCall(args: any, theme: any): string {
  const path = shortenHomePath(String(args?.path ?? "<missing-path>"));
  return `${styleToolTitle(theme, "lsp_diagnostics")} ${styleAccent(theme, path)}${formatWorkdirSuffix(args, theme)}${styleOutput(theme, formatOptionalArgs([["severity", args?.severity]]))}`;
}

function formatLspGotoDefinitionCall(args: any, theme: any): string {
  const path = shortenHomePath(String(args?.path ?? "<missing-path>"));
  const suffix = formatOptionalArgs([["line", args?.line], ["character", args?.character ?? 0]]);
  return `${styleToolTitle(theme, "lsp_goto_definition")} ${styleAccent(theme, path)}${formatWorkdirSuffix(args, theme)}${styleOutput(theme, suffix)}`;
}

function formatLspWorkspaceSymbolsCall(args: any, theme: any): string {
  const path = shortenHomePath(String(args?.path ?? "<missing-path>"));
  const query = formatInlineValue(String(args?.query ?? "<missing-query>"));
  return `${styleToolTitle(theme, "lsp_workspace_symbols")} ${styleAccent(theme, path)}${formatWorkdirSuffix(args, theme)} ${styleOutput(theme, query)}${styleOutput(theme, formatOptionalArgs([["limit", args?.limit]]))}`;
}

function formatLspJavaDecompileCall(args: any, theme: any): string {
  const path = shortenHomePath(String(args?.path ?? "<missing-path>"));
  const target = formatInlineValue(String(args?.target ?? "<missing-target>"));
  return `${styleToolTitle(theme, "lsp_java_decompile")} ${styleAccent(theme, path)}${formatWorkdirSuffix(args, theme)} ${styleOutput(theme, target)}`;
}

function fileUrlForTarget(target: string, cwd: string): string {
  if (target.startsWith("jdt://") || target.startsWith("file://")) return target;
  return pathToFileURL(resolveFromCwd(target, cwd)).href;
}

/**
 * Factory that returns a resolver scoped to a given `cwd`. The extension
 * should pass a factory that caches resolvers per cwd so we don't re-read
 * `pi-base.json` on every tool call.
 */
export type LspResolverFactory = (cwd: string) => LspDiscoveryResolver;

export function registerLspTools(pi: ExtensionAPI, options: { resolverFactory?: LspResolverFactory; getCollapsedResultLines?: CollapsedResultLinesResolver; getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver } = {}) {
  const getToolCwd = (params: any, ctx: any): string => resolveToolWorkdir(params.workdir, ctx.cwd ?? process.cwd()).cwd;
  const getResolverForPath = (toolPath: string, cwd: string): LspDiscoveryResolver => {
    const factory = options.resolverFactory;
    if (factory) return factory(dirname(resolveFromCwd(toolPath, cwd)));
    return new LspDiscoveryResolver({});
  };
  pi.registerTool({
    name: "lsp_diagnostics",
    label: "lsp_diagnostics",
    description: loadToolDescription("lsp_diagnostics"),
    promptSnippet: loadToolPromptSnippet("lsp_diagnostics"),
    parameters: lspDiagnosticsSchema,
    renderCall(args: any, _theme: any, context: any) {
      return renderCallText(formatLspDiagnosticsCall(args, _theme), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, _theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("lsp_diagnostics", undefined, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("lsp_diagnostics", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(result, { ...renderOptions, collapsedLines, maxCollapsedChars }, _theme, context);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      let serverId = "unknown";
      try {
        throwIfAborted(signal);
        const cwd = getToolCwd(params, ctx);
        const filePath = resolveFromCwd(params.path, cwd);
        const resolver = getResolverForPath(params.path, cwd);
        const client = await withAbort(lspManager.getClient(filePath, resolver), signal);
        serverId = client.serverId();
        let items = await client.diagnostics(filePath, signal);
        if (params.severity && params.severity !== "all") {
          items = items.filter((item: any) => ([, "error", "warning", "information", "hint"][item.severity] ?? "") === params.severity);
        }
        return { content: [{ type: "text" as const, text: formatDiagnostics(items) }] };
      } catch (error) {
        const e = error as Error & { code?: number };
        // Translate a narrow transient untyped "Internal error" into an
        // actionable hint without over-classifying real LSP failures.
        if (e.code == null && e.message === "Internal error") {
          const displayPath = resolveFromCwd(String(params.path), getToolCwd(params, ctx));
          return {
            content: [{
              type: "text" as const,
              text: `Error: LSP server '${serverId}' returned "Internal error" for ${displayPath}. ` +
                    `This often means the server has not finished opening the file or processing the ` +
                    `workspace yet (common on the first call or after opening a large project). Retry ` +
                    `in a few seconds. If the error persists, inspect the server logs or increase the ` +
                    `configured request timeout for this server in ~/.pi/agent/pi-base.json if it is ` +
                    `legitimately slow.`,
            }],
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  } as any);

  pi.registerTool({
    name: "lsp_goto_definition",
    label: "lsp_goto_definition",
    description: loadToolDescription("lsp_goto_definition"),
    promptSnippet: loadToolPromptSnippet("lsp_goto_definition"),
    parameters: lspGotoDefinitionSchema,
    renderCall(args: any, _theme: any, context: any) {
      return renderCallText(formatLspGotoDefinitionCall(args, _theme), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, _theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("lsp_goto_definition", undefined, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("lsp_goto_definition", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(result, { ...renderOptions, collapsedLines, maxCollapsedChars }, _theme, context);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      try {
        throwIfAborted(signal);
        const cwd = getToolCwd(params, ctx);
        const filePath = resolveFromCwd(params.path, cwd);
        if (params.line === undefined) throw new Error("line is required.");
        const line = requirePositiveInteger(params.line, "line");
        const character = requireNonNegativeInteger(params.character, "character", 0);
        const resolver = getResolverForPath(params.path, cwd);
        const client = await withAbort(lspManager.getClient(filePath, resolver), signal);
        if (!client.supportsMethod("textDocument/definition")) {
          return { content: [{ type: "text" as const, text: `Error: LSP server '${client.serverId()}' does not advertise go-to-definition. Try grep or read to locate definitions manually.` }], isError: true };
        }
        const result = await client.definition(filePath, line, character, signal);
        return { content: [{ type: "text" as const, text: formatLocations(result) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  } as any);

  pi.registerTool({
    name: "lsp_workspace_symbols",
    label: "lsp_workspace_symbols",
    description: loadToolDescription("lsp_workspace_symbols"),
    promptSnippet: loadToolPromptSnippet("lsp_workspace_symbols"),
    parameters: lspWorkspaceSymbolsSchema,
    renderCall(args: any, _theme: any, context: any) {
      return renderCallText(formatLspWorkspaceSymbolsCall(args, _theme), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, _theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("lsp_workspace_symbols", undefined, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("lsp_workspace_symbols", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(result, { ...renderOptions, collapsedLines, maxCollapsedChars }, _theme, context);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      try {
        throwIfAborted(signal);
        const cwd = getToolCwd(params, ctx);
        const filePath = resolveFromCwd(params.path, cwd);
        const limit = requireNonNegativeInteger(params.limit, "limit", 50);
        const resolver = getResolverForPath(params.path, cwd);
        const client = await withAbort(lspManager.getClient(filePath, resolver), signal);
        if (!client.supportsMethod("workspace/symbol")) {
          return { content: [{ type: "text" as const, text: `Error: LSP server '${client.serverId()}' does not advertise workspace/symbol support. Try grep, find, or read with offset/limit instead.` }], isError: true };
        }
        const result = await client.workspaceSymbols(params.query, signal);
        return { content: [{ type: "text" as const, text: formatWorkspaceSymbols(result, limit) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  } as any);

  pi.registerTool({
    name: "lsp_java_decompile",
    label: "lsp_java_decompile",
    description: loadToolDescription("lsp_java_decompile"),
    promptSnippet: loadToolPromptSnippet("lsp_java_decompile"),
    parameters: lspJavaDecompileSchema,
    renderCall(args: any, _theme: any, context: any) {
      return renderCallText(formatLspJavaDecompileCall(args, _theme), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, _theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("lsp_java_decompile", undefined, context, options.getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars("lsp_java_decompile", undefined, context, options.getCollapsedResultMaxChars);
      return renderRawResult(result, { ...renderOptions, collapsedLines, maxCollapsedChars }, _theme, context);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      try {
        throwIfAborted(signal);
        const cwd = getToolCwd(params, ctx);
        const workspaceFile = resolveFromCwd(params.path, cwd);
        const resolver = getResolverForPath(params.path, cwd);
        const client = await withAbort(lspManager.getClient(workspaceFile, resolver), signal);
        if (!client.supportsMethod("java/classFileContents")) {
          return { content: [{ type: "text" as const, text: `Error: lsp_java_decompile is only supported by jdtls; current server is '${client.serverId()}'.` }], isError: true };
        }
        const jdt = extractJdtUri(String(params.target));
        if (jdt) {
          const source = await client.classFileContents(jdt, signal);
          if (!source) return { content: [{ type: "text" as const, text: "Error: Could not load Java class file contents." }], isError: true };
          return { content: [{ type: "text" as const, text: source }] };
        }
        const targetUri = fileUrlForTarget(String(params.target), cwd);
        const source = await client.decompileClass(targetUri, signal);
        if (!source) return { content: [{ type: "text" as const, text: "Error: Could not decompile class." }], isError: true };
        return { content: [{ type: "text" as const, text: source }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  } as any);
}
