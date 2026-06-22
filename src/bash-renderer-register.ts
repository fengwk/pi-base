import { createBashTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderCallText, renderRawResult } from "./render.js";
import { bashSchema } from "./schemas/bash.js";
import {
  buildBashRenderText,
  buildHostShellOptions,
  formatBashCall,
  loadBashDescription,
  loadBashPromptSnippet,
  type BashDefinitionFactory,
  type BashFactory,
} from "./bash-renderer-core.js";
import { resolveToolWorkdir } from "./path-utils.js";

export {
  buildHostShellOptionsFor,
  describeOsNoteFor,
  describeShellFor,
  detectOsLabel,
  detectOsLabelFrom,
} from "./bash-renderer-core.js";

export function registerBashRendererTool(
  pi: Pick<ExtensionAPI, "registerTool">,
  options: { createBuiltInBashTool?: BashFactory; createBuiltInBashToolDefinition?: BashDefinitionFactory; getCollapsedResultLines?: any; getCollapsedResultMaxChars?: any } = {},
) {
  const shellOptions = buildHostShellOptions();
  const builtins = new Map<string, { tool: ReturnType<BashFactory>; definition: ReturnType<BashDefinitionFactory> }>();
  const getBuiltIn = (cwd: string) => {
    let entry = builtins.get(cwd);
    if (!entry) {
      entry = {
        tool: options.createBuiltInBashTool ? options.createBuiltInBashTool(cwd) : createBashTool(cwd, shellOptions),
        definition: options.createBuiltInBashToolDefinition ? options.createBuiltInBashToolDefinition(cwd) : {},
      };
      builtins.set(cwd, entry);
    }
    return entry;
  };

  const tool = {
    name: "bash",
    label: "bash",
    description: loadBashDescription(),
    promptSnippet: loadBashPromptSnippet(),
    parameters: bashSchema,
    renderCall(args: any, theme: any, context: any) {
      const state = context.state ?? {};
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      return renderCallText(formatBashCall(args, theme, context?.cwd), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const built = buildBashRenderText(result, renderOptions, theme, context, options.getCollapsedResultLines, options.getCollapsedResultMaxChars);
      const builtIn = getBuiltIn(built.cwd);
      const configuredCollapsedLines = options.getCollapsedResultLines?.(context?.cwd ?? process.cwd(), "bash");
      if (configuredCollapsedLines === undefined && built.maxCollapsedChars === undefined && options.createBuiltInBashToolDefinition && builtIn.definition.renderResult) {
        const builtInContext = {
          ...context,
          state: built.state,
          invalidate: context?.invalidate ?? (() => undefined),
        };
        try {
          return builtIn.definition.renderResult(result, renderOptions, theme, builtInContext);
        } catch {
          // Fall back when an injected test renderer cannot run.
        }
      }

      try {
        return built.text;
      } catch {
        return renderRawResult(result, { ...renderOptions, collapsedLines: built.collapsedLines, maxCollapsedChars: built.maxCollapsedChars }, theme, context);
      }
    },
    async execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx: any = {}) {
      try {
        const { cwd } = resolveToolWorkdir(params.workdir, ctx.cwd ?? process.cwd());
        const builtIn = getBuiltIn(cwd);
        const timeoutSeconds = params.timeout_seconds === undefined ? undefined : Number(params.timeout_seconds);
        return await builtIn.tool.execute(
          toolCallId,
          {
            command: params.command,
            timeout: timeoutSeconds,
          },
          signal,
          onUpdate,
          ctx,
        );
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  };
  pi.registerTool(tool as any);
  return tool;
}
