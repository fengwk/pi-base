type TranscriptMessage = {
  role?: string;
  content?: unknown;
  command?: string;
  output?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};

type ToolCallPart = {
  name: string;
  arguments?: unknown;
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

function extractAttachmentLabels(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type !== "text")
    .map((part) => {
      const type = String((part as { type?: unknown }).type ?? "unknown");
      if (type === "image") return "[image attachment]";
      return `[${type} attachment]`;
    });
}

function stringifyCompact(value: unknown, maxChars = 240): string | undefined {
  if (value === undefined) return undefined;
  const rendered = typeof value === "string"
    ? value
    : (() => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })();
  const trimmed = rendered.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed;
}

function pushSection(lines: string[], header: string, body: string | string[]): void {
  const normalized = Array.isArray(body) ? body : body.split("\n");
  const trimmed = normalized.map((line) => line.replace(/\s+$/g, ""));
  while (trimmed.length > 0 && trimmed[0]?.trim().length === 0) trimmed.shift();
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.trim().length === 0) trimmed.pop();
  if (trimmed.length === 0) return;
  if (lines.length > 0) lines.push("───");
  lines.push(header);
  lines.push(...trimmed);
}

function extractToolCalls(message: TranscriptMessage): ToolCallPart[] {
  if (!Array.isArray(message.content)) return [];
  const calls: ToolCallPart[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object") continue;
    if ((part as { type?: string }).type !== "toolCall") continue;
    const name = String((part as { name?: unknown; toolName?: unknown }).name ?? (part as { toolName?: unknown }).toolName ?? "unknown").trim() || "unknown";
    calls.push({ name, arguments: (part as { arguments?: unknown }).arguments });
  }
  return calls;
}

function pushAssistant(lines: string[], message: TranscriptMessage): void {
  const text = extractTextContent(message.content).trim();
  if (text) pushSection(lines, "Assistant:", text);

  for (const call of extractToolCalls(message)) {
    const body = [`name: ${call.name}`];
    const args = stringifyCompact(call.arguments);
    if (args) body.push(`arguments: ${args}`);
    pushSection(lines, "Tool Call:", body);
  }
}

function pushToolResult(lines: string[], message: TranscriptMessage, maxChars: number): void {
  const text = extractTextContent(message.content).trim();
  const attachments = extractAttachmentLabels(message.content);
  if (!text && attachments.length === 0) return;

  const body = [
    `name: ${(typeof message.toolName === "string" && message.toolName.trim()) || "unknown"}`,
    `status: ${message.isError ? "error" : "ok"}`,
  ];
  if (typeof message.toolCallId === "string" && message.toolCallId.trim()) body.push(`call_id: ${message.toolCallId.trim()}`);

  if (text) {
    const truncated = text.length > maxChars ? `${text.slice(0, maxChars)}... (truncated)` : text;
    body.push("content:", ...truncated.split("\n"));
  } else {
    body.push("attachments:", ...attachments);
  }

  pushSection(lines, "Tool Result:", body);
}

function pushBashExecution(lines: string[], message: TranscriptMessage): void {
  const command = typeof message.command === "string" ? message.command.trim() : "";
  const output = typeof message.output === "string" ? message.output.trim() : "";
  if (!command && !output) return;
  const body: string[] = [];
  if (command) body.push(`command: ${command}`);
  if (output) body.push("output:", ...output.split("\n"));
  pushSection(lines, "Shell:", body);
}

export function buildTranscriptLinesCore(messages: unknown[], options: TranscriptOptions = {}): string[] {
  const lines: string[] = [];
  const maxToolResultChars = options.maxToolResultChars ?? 800;
  const typedMessages = asTranscriptMessages(messages);

  for (const message of typedMessages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "user") {
      const text = extractTextContent(message.content).trim();
      if (text) pushSection(lines, "User:", text);
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
    if (message.role === "bashExecution") pushBashExecution(lines, message);
  }

  const responseText = options.responseText?.trim();
  if (responseText) pushSection(lines, "Streaming Assistant:", responseText);
  if (options.activeTools && options.activeTools.length > 0) {
    for (const tool of options.activeTools) pushSection(lines, "Running Tool:", `name: ${tool}`);
  }

  return lines;
}

export function buildTranscriptTextCore(messages: unknown[], options: TranscriptOptions = {}): string {
  return buildTranscriptLinesCore(messages, options).join("\n");
}

export function buildTailLinesCore(messages: unknown[], options: TranscriptOptions = {}, maxLines = 10): string[] {
  const transcript = buildTranscriptLinesCore(messages, options).filter((line) => line.trim().length > 0);
  if (transcript.length === 0) return ["(waiting for output...)"];
  return transcript.slice(-Math.max(1, maxLines));
}

export function summarizeTailLinesCore(lines: string[]): string {
  const last = [...lines].reverse().find((line) => line.trim().length > 0) ?? "(no output)";
  return last.length > 120 ? `${last.slice(0, 117)}...` : last;
}

export function getFinalAssistantTextCore(messages: unknown[]): string {
  const typedMessages = asTranscriptMessages(messages);
  for (let index = typedMessages.length - 1; index >= 0; index--) {
    const message = typedMessages[index];
    if (!message || typeof message !== "object" || message.role !== "assistant") continue;
    const text = extractTextContent(message.content).trim();
    if (text) return text;
  }
  return "";
}
