export interface TimeoutResult {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
}

export const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

export function createTimeoutSignal(parent: AbortSignal | undefined, timeoutSeconds: number): TimeoutResult {
  timeoutSeconds = parseTimeoutSeconds(timeoutSeconds, "timeoutSeconds", timeoutSeconds);
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) {
    controller.abort(parent.reason);
    return {
      signal: controller.signal,
      cleanup: () => undefined,
      didTimeout: () => false,
    };
  }
  parent?.addEventListener("abort", forwardAbort, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Timed out after ${timeoutSeconds}s`));
  }, timeoutSeconds * 1000);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", forwardAbort);
    },
    didTimeout: () => timedOut,
  };
}

export function parsePositiveNumber(value: unknown, name: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

export function parseTimeoutSeconds(value: unknown, name: string, defaultValue: number): number {
  const parsed = parsePositiveNumber(value, name, defaultValue);
  if (parsed > MAX_TIMEOUT_SECONDS) {
    throw new Error(`${name} must be <= ${MAX_TIMEOUT_SECONDS}.`);
  }
  return parsed;
}
