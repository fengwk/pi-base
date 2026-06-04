import { isContextCompressionPlaceholderText } from "./context-compression.js";

const ANTHROPIC_CACHE_MARKER_LIMIT = 4;

type RecordLike = Record<string, unknown>;

interface BlockLocation {
  block: RecordLike;
  messageIndex: number;
  blockIndex: number;
}

function isRecord(value: unknown): value is RecordLike {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getMessages(payload: unknown): RecordLike[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined;
  return payload.messages.filter(isRecord);
}

function getContentBlocks(message: RecordLike): RecordLike[] {
  return Array.isArray(message.content) ? message.content.filter(isRecord) : [];
}

function hasCacheControl(block: RecordLike): boolean {
  return isRecord(block.cache_control);
}

function cloneCacheControl(block: RecordLike): RecordLike {
  return { ...(block.cache_control as RecordLike) };
}

function toolResultContentHasPiBasePlaceholder(content: unknown): boolean {
  if (typeof content === "string") return isContextCompressionPlaceholderText(content.trim());
  if (!Array.isArray(content)) return false;
  return content.some((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" && isContextCompressionPlaceholderText(item.text.trim()));
}

function findLastPiBasePlaceholderToolResult(messages: RecordLike[]): BlockLocation | undefined {
  let found: BlockLocation | undefined;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const blocks = getContentBlocks(messages[messageIndex]);
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex];
      if (block.type === "tool_result" && toolResultContentHasPiBasePlaceholder(block.content)) {
        found = { block, messageIndex, blockIndex };
      }
    }
  }
  return found;
}

function isAfter(location: BlockLocation, boundary: BlockLocation): boolean {
  return location.messageIndex > boundary.messageIndex
    || (location.messageIndex === boundary.messageIndex && location.blockIndex > boundary.blockIndex);
}

function findFirstMessageMarkerAfter(messages: RecordLike[], boundary: BlockLocation): BlockLocation | undefined {
  for (let messageIndex = boundary.messageIndex; messageIndex < messages.length; messageIndex++) {
    const blocks = getContentBlocks(messages[messageIndex]);
    const startBlockIndex = messageIndex === boundary.messageIndex ? boundary.blockIndex + 1 : 0;
    for (let blockIndex = startBlockIndex; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex];
      if (hasCacheControl(block)) return { block, messageIndex, blockIndex };
    }
  }
  return undefined;
}

function countCacheControlsInValue(value: unknown): number {
  if (!isRecord(value)) return 0;
  let count = hasCacheControl(value) ? 1 : 0;
  if (Array.isArray(value.content)) {
    for (const block of value.content) count += countCacheControlsInValue(block);
  }
  return count;
}

function countCacheControls(payload: unknown): number {
  if (!isRecord(payload)) return 0;
  let count = 0;
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) count += countCacheControlsInValue(block);
  } else if (isRecord(payload.system)) {
    count += countCacheControlsInValue(payload.system);
  }
  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) count += countCacheControlsInValue(tool);
  }
  const messages = getMessages(payload) ?? [];
  for (const message of messages) count += countCacheControlsInValue(message);
  return count;
}

/**
 * Move or copy an existing Anthropic message cache marker to pi-base's latest
 * compressed tool_result boundary. System and tool markers are intentionally
 * left untouched.
 */
export function applyAnthropicCompressionBoundaryCacheMarker(payload: unknown): boolean {
  const messages = getMessages(payload);
  if (!messages) return false;

  const boundary = findLastPiBasePlaceholderToolResult(messages);
  if (!boundary) return false;
  if (hasCacheControl(boundary.block)) return false;

  const source = findFirstMessageMarkerAfter(messages, boundary);
  if (!source || !isAfter(source, boundary)) return false;

  const cacheControl = cloneCacheControl(source.block);
  if (countCacheControls(payload) < ANTHROPIC_CACHE_MARKER_LIMIT) {
    boundary.block.cache_control = cacheControl;
  } else {
    boundary.block.cache_control = cacheControl;
    delete source.block.cache_control;
  }

  return true;
}
