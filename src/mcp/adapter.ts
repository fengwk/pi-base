import { createHash } from "node:crypto";
import type { TSchema } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CollapsedResultLinesResolver, type CollapsedResultMaxCharsResolver, renderStreamingCallText, renderRawResult, resolveCollapsedResultLines, resolveCollapsedResultMaxChars, styleOutput, styleToolTitle } from "../render.js";
import { convertJsonSchemaToTypeBox } from "./schema.js";
import type { McpTool, McpToolCallResult, McpToolResultContent, McpServerConfig } from "./types.js";

export interface McpToolCallExecutor {
  (serverKey: string, toolName: string, args: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal): Promise<McpToolCallResult>;
}

export interface CreateMcpToolDefinitionOptions {
  serverKey: string;
  serverConfig: McpServerConfig;
  tool: McpTool;
  callTool: McpToolCallExecutor;
  getCollapsedResultLines?: CollapsedResultLinesResolver;
  getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver;
}

export function resolveMcpToolPrefix(serverKey: string, toolPrefix: string | undefined): string {
  return toolPrefix ?? serverKey;
}

const MCP_TOOL_NAME_MAX_LENGTH = 64;
const MCP_TOOL_NAME_HASH_LENGTH = 12;
const MCP_TOOL_NAME_SAFE_PATTERN = /^[A-Za-z0-9_-]+$/;

export function buildMcpToolName(serverKey: string, toolName: string, toolPrefix: string | undefined): string {
  const prefix = resolveMcpToolPrefix(serverKey, toolPrefix);
  const rawAlias = prefix === "" ? toolName : `${prefix}_${toolName}`;
  if (rawAlias.length <= MCP_TOOL_NAME_MAX_LENGTH && MCP_TOOL_NAME_SAFE_PATTERN.test(rawAlias)) {
    return rawAlias;
  }

  const collapsed = rawAlias.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const hash = createHash("sha256").update(rawAlias).digest("hex").slice(0, MCP_TOOL_NAME_HASH_LENGTH);
  if (!collapsed) return hash;

  const suffix = `_${hash}`;
  const head = collapsed.slice(0, MCP_TOOL_NAME_MAX_LENGTH - suffix.length).replace(/_+$/g, "");
  return head ? `${head}${suffix}` : hash;
}

const MCP_DEFAULT_COLLAPSED_RESULT_MAX_CHARS = 2_500;
export function createMcpToolDefinition(options: CreateMcpToolDefinitionOptions): ToolDefinition<TSchema, { server: string; tool: string }> {
  const { serverKey, serverConfig, tool, callTool, getCollapsedResultLines, getCollapsedResultMaxChars } = options;
  const aliasName = buildMcpToolName(serverKey, tool.name, serverConfig.toolPrefix);
  const parameters = buildParameters(tool);

  return {
    name: aliasName,
    label: `${serverKey}: ${tool.name}`,
    description: tool.description || `Call ${tool.name} on MCP server ${serverKey}`,
    parameters,
    renderCall(args: unknown, theme, context) {
      const objectArgs = isRecord(args) ? args : {};
      const callText = Object.keys(objectArgs).length === 0
        ? styleToolTitle(theme, aliasName)
        : `${styleToolTitle(theme, aliasName)}\n${styleOutput(theme, stringifyJson(objectArgs))}`;
      return renderStreamingCallText(callText, theme, context);
    },
    renderResult(result, renderOptions, theme, context) {
      const collapsedLines = resolveCollapsedResultLines(aliasName, undefined, context, getCollapsedResultLines);
      const maxCollapsedChars = resolveCollapsedResultMaxChars(aliasName, MCP_DEFAULT_COLLAPSED_RESULT_MAX_CHARS, context, getCollapsedResultMaxChars);
      return renderRawResult(result, {
        ...renderOptions,
        collapsedLines,
        maxCollapsedChars,
      }, theme, context);
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
            content: convertErrorToContent(result),
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

type McpOutputContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function convertResultToContent(result: McpToolCallResult): McpOutputContent[] {
  const output: McpOutputContent[] = [];
  for (const item of result.content ?? []) {
    output.push(convertContentItem(item));
  }
  if (result.structuredContent !== undefined) {
    const structuredText = stringifyJson(result.structuredContent);
    const alreadyPresent = output.some((item) =>
      item.type === "text" && item.text.trim() === structuredText.trim());
    if (!alreadyPresent) {
      output.push({ type: "text", text: `[structured content]\n${structuredText}` });
    }
  }
  if (output.length === 0) {
    output.push({ type: "text", text: "No content returned." });
  }
  return output;
}

function convertErrorToContent(result: McpToolCallResult): Array<{ type: "text"; text: string }> {
  const lines: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      lines.push(item.text);
    } else if (item.type === "image" || item.type === "audio") {
      lines.push(summarizeBinaryContent(item, true));
    } else if (item.type === "resource") {
      const converted = convertContentItem(item);
      lines.push(converted.type === "text" ? converted.text : "[resource content omitted from error]");
    } else if (item.data !== undefined) {
      lines.push(typeof item.data === "string"
        ? `[${item.type} data omitted from error: ${item.data.length} characters]`
        : stringifyJson(item.data));
    } else {
      lines.push(`[${item.type} content omitted from error]`);
    }
  }
  if (result.structuredContent !== undefined) lines.push(stringifyJson(result.structuredContent));
  return [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "Unknown MCP error" }];
}

function convertContentItem(item: McpToolResultContent): McpOutputContent {
  if (item.type === "text") {
    return typeof item.text === "string"
      ? { type: "text", text: item.text }
      : { type: "text", text: "[text content omitted: missing text field]" };
  }
  if (item.type === "image") {
    return typeof item.data === "string" && typeof item.mimeType === "string"
      ? { type: "image", data: item.data, mimeType: item.mimeType }
      : { type: "text", text: "[image content omitted]" };
  }
  if (item.type === "audio") {
    return { type: "text", text: summarizeBinaryContent(item, false) };
  }
  if (item.type === "resource_link") {
    const title = typeof item.title === "string"
      ? item.title
      : typeof item.name === "string"
        ? item.name
        : typeof item.uri === "string"
          ? item.uri
          : "unknown resource";
    const uri = typeof item.uri === "string" ? item.uri : "unknown URI";
    const mime = typeof item.mimeType === "string" ? ` (${item.mimeType})` : "";
    const description = typeof item.description === "string" ? ` — ${item.description}` : "";
    return { type: "text", text: `[resource_link: ${title}${mime} — ${uri}]${description}` };
  }
  if (item.type === "resource" && isRecord(item.resource)) {
    const uri = typeof item.resource.uri === "string" ? item.resource.uri : "unknown URI";
    const mime = typeof item.resource.mimeType === "string" ? item.resource.mimeType : "application/octet-stream";
    if (typeof item.resource.text === "string") {
      return { type: "text", text: `[resource ${uri} (${mime})]\n${item.resource.text}` };
    }
    if (typeof item.resource.blob === "string") {
      return {
        type: "text",
        text: `[resource ${uri} (${mime}): binary blob ~${estimateBase64Bytes(item.resource.blob)} bytes omitted]`,
      };
    }
  }
  if (item.data !== undefined && typeof item.data !== "string") {
    return { type: "text", text: stringifyJson(item.data) };
  }
  return { type: "text", text: `[${item.type || "unknown"} content omitted]` };
}

function summarizeBinaryContent(item: McpToolResultContent, error: boolean): string {
  const mime = typeof item.mimeType === "string" ? item.mimeType : "unknown";
  const bytes = typeof item.data === "string" ? estimateBase64Bytes(item.data) : 0;
  const suffix = error ? " from error" : "";
  return `[${item.type} content omitted${suffix}: mimeType=${mime}, ~${bytes} bytes]`;
}

function estimateBase64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[Unserializable data]";
  }
}
