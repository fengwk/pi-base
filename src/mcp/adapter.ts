import type { TSchema } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { renderCallText, styleOutput, styleToolTitle } from "../render.js";
import { convertJsonSchemaToTypeBox } from "./schema.js";
import type { McpTool, McpToolCallResult, McpServerConfig } from "./types.js";

export interface McpToolCallExecutor {
  (serverKey: string, toolName: string, args: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal): Promise<McpToolCallResult>;
}

export interface CreateMcpToolDefinitionOptions {
  serverKey: string;
  serverConfig: McpServerConfig;
  tool: McpTool;
  callTool: McpToolCallExecutor;
}

export function resolveMcpToolPrefix(serverKey: string, toolPrefix: string | undefined): string {
  return toolPrefix ?? serverKey;
}

export function buildMcpToolName(serverKey: string, toolName: string, toolPrefix: string | undefined): string {
  const prefix = resolveMcpToolPrefix(serverKey, toolPrefix);
  return prefix === "" ? toolName : `${prefix}_${toolName}`;
}

export function createMcpToolDefinition(options: CreateMcpToolDefinitionOptions): ToolDefinition<TSchema, { server: string; tool: string }> {
  const { serverKey, serverConfig, tool, callTool } = options;
  const aliasName = buildMcpToolName(serverKey, tool.name, serverConfig.toolPrefix);
  const parameters = buildParameters(tool);

  return {
    name: aliasName,
    label: `${serverKey}: ${tool.name}`,
    description: tool.description || `Call ${tool.name} on MCP server ${serverKey}`,
    parameters,
    renderCall(args: unknown, theme, context) {
      const formattedArgs = stringifyJson((args ?? {}) as Record<string, unknown>);
      const callText = `${styleToolTitle(theme, aliasName)}\n${styleOutput(theme, formattedArgs)}`;
      return renderCallText(callText, context.lastComponent);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Tool call cancelled." }],
          details: { server: serverKey, tool: tool.name },
          isError: true,
        };
      }

      try {
        const result = await callTool(serverKey, tool.name, (params ?? {}) as Record<string, unknown>, ctx, signal);
        if (result.isError) {
          return {
            content: [{ type: "text" as const, text: extractErrorText(result) }],
            details: { server: serverKey, tool: tool.name },
            isError: true,
          };
        }
        return {
          content: convertResultToContent(result),
          details: { server: serverKey, tool: tool.name },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `MCP Error: ${error instanceof Error ? error.message : String(error)}` }],
          details: { server: serverKey, tool: tool.name },
          isError: true,
        };
      }
    },
  };
}

function buildParameters(tool: McpTool): TSchema {
  try {
    return convertJsonSchemaToTypeBox(tool.inputSchema);
  } catch {
    return Type.Any();
  }
}

function extractErrorText(result: McpToolCallResult): string {
  const text = convertResultToContent(result)
    .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  return text || "Unknown MCP error";
}

function convertResultToContent(result: McpToolCallResult): Array<{ type: "text"; text: string }> {
  const output: Array<{ type: "text"; text: string }> = [];
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      output.push({ type: "text", text: item.text });
      continue;
    }
    if (item.data !== undefined) {
      output.push({ type: "text", text: stringifyJson(item.data) });
      continue;
    }
    output.push({ type: "text", text: `[${item.type} content omitted]` });
  }
  if (output.length === 0 && result.structuredContent !== undefined) {
    output.push({ type: "text", text: stringifyJson(result.structuredContent) });
  }
  if (output.length === 0) {
    output.push({ type: "text", text: "No content returned." });
  }
  return output;
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[Unserializable data]";
  }
}
