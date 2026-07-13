import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToolDescription, loadToolPromptSnippet } from "../tool-prompt.js";
import { withPiBaseErrorMarker } from "../tool-error-marker.js";
import {
  // lspDiagnosticsSchema,
  lspGotoDefinitionSchema,
  lspJavaDecompileSchema,
  lspWorkspaceSymbolsSchema,
} from "../schemas/lsp.js";
import { mapFilePathToPath } from "../tool-arg-aliases.js";
import { lspManager } from "./client.js";
import {
  // executeLspDiagnostics,
  executeLspGotoDefinition,
  executeLspJavaDecompile,
  executeLspWorkspaceSymbols,
  // formatLspDiagnosticsCall,
  formatLspGotoDefinitionCall,
  formatLspJavaDecompileCall,
  formatLspWorkspaceSymbolsCall,
  renderLspCall,
  renderLspResult,
  type LspResolverFactory,
} from "./tool-helpers.js";

export type { LspResolverFactory } from "./tool-helpers.js";

export function registerLspTools(pi: ExtensionAPI, options: { resolverFactory?: LspResolverFactory; getCollapsedResultLines?: any; getCollapsedResultMaxChars?: any } = {}) {
  // Disabled for 0.1.x evaluation; restore or remove before the next minor release.
  // Uncomment this block and its imports above to restore the tool.
  // pi.registerTool(withPiBaseErrorMarker({
  //   name: "lsp_diagnostics",
  //   label: "lsp_diagnostics",
  //   description: loadToolDescription("lsp_diagnostics"),
  //   promptSnippet: loadToolPromptSnippet("lsp_diagnostics"),
  //   prepareArguments(args: unknown) {
  //     return mapFilePathToPath(args);
  //   },
  //   parameters: lspDiagnosticsSchema,
  //   renderCall(args: any, theme: any, context: any) {
  //     const mappedArgs = mapFilePathToPath(args);
  //     return renderLspCall(formatLspDiagnosticsCall(mappedArgs, theme, context?.cwd), theme, context);
  //   },
  //   renderResult(result: any, renderOptions: any, theme: any, context: any) {
  //     return renderLspResult("lsp_diagnostics", result, renderOptions, theme, context, options);
  //   },
  //   async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
  //     return executeLspDiagnostics(params, signal, ctx, options.resolverFactory, lspManager);
  //   },
  // }) as any);

  pi.registerTool(withPiBaseErrorMarker({
    name: "lsp_goto_definition",
    label: "lsp_goto_definition",
    description: loadToolDescription("lsp_goto_definition"),
    promptSnippet: loadToolPromptSnippet("lsp_goto_definition"),
    prepareArguments(args: unknown) {
      return mapFilePathToPath(args);
    },
    parameters: lspGotoDefinitionSchema,
    renderCall(args: any, theme: any, context: any) {
      const mappedArgs = mapFilePathToPath(args);
      return renderLspCall(formatLspGotoDefinitionCall(mappedArgs, theme, context?.cwd), theme, context);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      return renderLspResult("lsp_goto_definition", result, renderOptions, theme, context, options);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      return executeLspGotoDefinition(params, signal, ctx, options.resolverFactory, lspManager);
    },
  }) as any);

  pi.registerTool(withPiBaseErrorMarker({
    name: "lsp_workspace_symbols",
    label: "lsp_workspace_symbols",
    description: loadToolDescription("lsp_workspace_symbols"),
    promptSnippet: loadToolPromptSnippet("lsp_workspace_symbols"),
    prepareArguments(args: unknown) {
      return mapFilePathToPath(args);
    },
    parameters: lspWorkspaceSymbolsSchema,
    renderCall(args: any, theme: any, context: any) {
      const mappedArgs = mapFilePathToPath(args);
      return renderLspCall(formatLspWorkspaceSymbolsCall(mappedArgs, theme, context?.cwd), theme, context);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      return renderLspResult("lsp_workspace_symbols", result, renderOptions, theme, context, options);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      return executeLspWorkspaceSymbols(params, signal, ctx, options.resolverFactory, lspManager);
    },
  }) as any);

  pi.registerTool(withPiBaseErrorMarker({
    name: "lsp_java_decompile",
    label: "lsp_java_decompile",
    description: loadToolDescription("lsp_java_decompile"),
    promptSnippet: loadToolPromptSnippet("lsp_java_decompile"),
    prepareArguments(args: unknown) {
      return mapFilePathToPath(args);
    },
    parameters: lspJavaDecompileSchema,
    renderCall(args: any, theme: any, context: any) {
      const mappedArgs = mapFilePathToPath(args);
      return renderLspCall(formatLspJavaDecompileCall(mappedArgs, theme, context?.cwd), theme, context);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      return renderLspResult("lsp_java_decompile", result, renderOptions, theme, context, options);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      return executeLspJavaDecompile(params, signal, ctx, options.resolverFactory, lspManager);
    },
  }) as any);
}
