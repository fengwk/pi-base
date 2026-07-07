const PI_BASE_TOOL_RESULT_MARKER = "__piBase";

interface PiBaseToolResultMarker {
  isError?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function markPiBaseToolErrorDetails(details: unknown): Record<string, unknown> {
  const base = isRecord(details) ? details : {};
  const marker = isRecord(base[PI_BASE_TOOL_RESULT_MARKER])
    ? { ...(base[PI_BASE_TOOL_RESULT_MARKER] as PiBaseToolResultMarker), isError: true as const }
    : { isError: true as const };
  return { ...base, [PI_BASE_TOOL_RESULT_MARKER]: marker };
}

export function hasPiBaseToolErrorMarker(details: unknown): boolean {
  return isRecord(details)
    && isRecord(details[PI_BASE_TOOL_RESULT_MARKER])
    && (details[PI_BASE_TOOL_RESULT_MARKER] as PiBaseToolResultMarker).isError === true;
}

export function markPiBaseToolErrorResult<T extends { details?: unknown; isError?: boolean }>(result: T): T {
  if (result?.isError !== true) return result;
  return {
    ...result,
    details: markPiBaseToolErrorDetails(result.details),
  };
}

export function withPiBaseErrorMarker<TTool extends { execute: (...args: any[]) => Promise<any> }>(tool: TTool): TTool {
  return {
    ...tool,
    async execute(...args: Parameters<TTool["execute"]>) {
      const result = await tool.execute(...args);
      return markPiBaseToolErrorResult(result);
    },
  };
}
