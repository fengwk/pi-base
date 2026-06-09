type TranscriptMessage = {
  role?: string;
  content?: unknown;
  command?: string;
  output?: string;
};

function asTranscriptMessages(messages: unknown[]): TranscriptMessage[] {
  return messages as TranscriptMessage[];
}

export interface TranscriptOptions {
  responseText?: string;
  activeTools?: string[];
  maxToolResultChars?: number;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("\n");
}

function pushSection(lines: string[], header: string, body: string): void {
  const trimmed = body.trim();
  if (!trimmed) return;
  if (lines.length > 0) lines.push("───");
  lines.push(header);
  lines.push(...trimmed.split("\n"));
}

function pushAssistant(lines: string[], message: TranscriptMessage): void {
  const textParts: string[] = [];
  const toolCalls: string[] = [];
  if (typeof message.content === "string") {
    if (message.content.trim()) textParts.push(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      if ((part as { type?: string }).type === "text") {
        const text = String((part as { text?: unknown }).text ?? "");
        if (text.trim()) textParts.push(text);
        continue;
      }
      if ((part as { type?: string }).type === "toolCall") {
        const name = String((part as { name?: unknown; toolName?: unknown }).name ?? (part as { toolName?: unknown }).toolName ?? "unknown");
        toolCalls.push(name);
      }
    }
  }

  if (textParts.length === 0 && toolCalls.length === 0) return;
  if (lines.length > 0) lines.push("───");
  lines.push("[Assistant]");
  if (textParts.length > 0) lines.push(...textParts.join("\n").trim().split("\n"));
  for (const name of toolCalls) lines.push(`[Tool] ${name}`);
}

function pushToolResult(lines: string[], message: TranscriptMessage, maxChars: number): void {
  const text = extractTextContent(message.content);
  if (!text.trim()) return;
  const truncated = text.length > maxChars ? `${text.slice(0, maxChars)}... (truncated)` : text;
  pushSection(lines, "[Result]", truncated);
}

function pushBashExecution(lines: string[], message: TranscriptMessage): void {
  const command = typeof message.command === "string" ? message.command.trim() : "";
  const output = typeof message.output === "string" ? message.output.trim() : "";
  if (!command && !output) return;
  if (lines.length > 0) lines.push("───");
  if (command) lines.push(`[Bash] ${command}`);
  if (output) lines.push(...output.split("\n"));
}

export function buildTranscriptLines(messages: unknown[], options: TranscriptOptions = {}): string[] {
  const lines: string[] = [];
  const maxToolResultChars = options.maxToolResultChars ?? 800;
  const typedMessages = asTranscriptMessages(messages);

  for (const message of typedMessages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "user") {
      pushSection(lines, "[User]", extractTextContent(message.content));
      continue;
    }
    if (message.role === "assistant") {
      pushAssistant(lines, message);
      continue;
    }
    if (message.role === "toolResult") {
      pushToolResult(lines, message, maxToolResultChars);
      continue;
    }
    if (message.role === "bashExecution") {
      pushBashExecution(lines, message);
    }
  }

  const responseText = options.responseText?.trim();
  if (responseText) {
    pushSection(lines, "[Assistant…]", responseText);
  }

  if (options.activeTools && options.activeTools.length > 0) {
    if (lines.length > 0) lines.push("───");
    for (const tool of options.activeTools) lines.push(`[Running] ${tool}`);
  }

  /* v8 ignore next -- trivial array return */
  return lines;
}

export function buildTailLines(messages: unknown[], options: TranscriptOptions = {}, maxLines = 10): string[] {
  const transcript = buildTranscriptLines(messages, options).filter((line) => line.trim().length > 0);
  if (transcript.length === 0) return ["(waiting for output...)"];
  return transcript.slice(-Math.max(1, maxLines));
}

export function summarizeTailLines(lines: string[]): string {
  const last = [...lines].reverse().find((line) => line.trim().length > 0) ?? "(no output)";
  return last.length > 120 ? `${last.slice(0, 117)}...` : last;
}

export function getFinalAssistantText(messages: unknown[]): string {
  const typedMessages = asTranscriptMessages(messages);
  for (let index = typedMessages.length - 1; index >= 0; index--) {
    const message = typedMessages[index];
    if (!message || typeof message !== "object" || message.role !== "assistant") continue;
    const text = extractTextContent(message.content).trim();
    if (text) return text;
  }
  return "";
}
