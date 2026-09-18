import { prepareReadArguments } from "./read-core.js";
import { mapFilePathToPath } from "./tool-arg-aliases.js";

const FILE_PATH_ALIAS_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "edit",
  "write",
  "lsp_goto_definition",
  "lsp_workspace_symbols",
  "lsp_java_decompile",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalizeKnownToolArguments(toolName: string, args: unknown): unknown {
  if (!FILE_PATH_ALIAS_TOOL_NAMES.has(toolName)) return args;
  return toolName === "read" ? prepareReadArguments(args) : mapFilePathToPath(args);
}

/**
 * Canonicalize only argument quirks already accepted by pi-base at execution time.
 * Keeping this provider-independent message rewrite aligned with those fallbacks
 * ensures later turns and resumed sessions see the same call that was executed.
 */
export function canonicalizeAssistantToolCalls<T>(message: T): T {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }

  let changed = false;
  const content = message.content.map((part) => {
    if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") {
      return part;
    }
    const args = canonicalizeKnownToolArguments(part.name, part.arguments);
    if (args === part.arguments) return part;
    changed = true;
    return { ...part, arguments: args };
  });

  return (changed ? { ...message, content } : message) as T;
}
