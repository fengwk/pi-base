import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { registerCompactionModel } from "../src/compaction-model.js";
import { createToolRegistry } from "./helpers.js";

const currentModel = { provider: "openai", id: "gpt-5" };
const configuredModel = { provider: "google", id: "gemini-2.5-flash" };

function preparation() {
  return {
    firstKeptEntryId: "keep-entry",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 1_000,
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
  };
}

function compactEvent(signal: AbortSignal) {
  return {
    type: "session_before_compact",
    preparation: preparation(),
    branchEntries: [],
    customInstructions: "Preserve implementation details.",
    reason: "manual",
    willRetry: false,
    signal,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("configured compaction model", () => {
  it("uses the registry stream for real compaction without replaying resolved OAuth credentials", async () => {
    // Intent: run the real compact() pipeline with an offline registry stream. Replaying a
    // resolved OAuth token as an explicit apiKey would select the wrong provider auth branch.
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    const model = {
      provider: "summary-fixture", id: "fake", name: "Summary fixture",
      api: "openai-completions" as const, baseUrl: "https://invalid.local",
      reasoning: true, input: ["text" as const], contextWindow: 100_000, maxTokens: 1_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "text", text: "Offline summary." }], stopReason: "stop", timestamp: 0,
      usage: {
        input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const streamSimple = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    });
    const modelRegistry = {
      find: vi.fn().mockReturnValue(model),
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({
        ok: true, apiKey: "resolved-oauth-token", headers: { authorization: "resolved-header" },
        baseUrl: "https://resolved.invalid", env: { RESOLVED_AUTH: "1" },
      }),
      streamSimple,
    };
    const registry = createToolRegistry({ model: currentModel, modelRegistry });
    registerCompactionModel(registry.pi as never, () => ({
      compactionModel: { provider: model.provider, modelId: model.id },
      compactionThinkingLevel: "high",
    }));
    const signal = new AbortController().signal;

    const result = await registry.emit("session_before_compact", compactEvent(signal));

    expect(result).toMatchObject({ compaction: {
      summary: "Offline summary.", firstKeptEntryId: "keep-entry", tokensBefore: 1_000,
    } });
    expect(streamSimple).toHaveBeenCalledOnce();
    const [requestModel, , options] = streamSimple.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>];
    expect(requestModel).toBe(model);
    expect(options).toMatchObject({ signal, reasoning: "high", cacheRetention: "none" });
    expect(options.apiKey).toBeUndefined();
    expect(options.headers).toBeUndefined();
    expect(options.env).toBeUndefined();
    expect(streamSimple.mock.contexts[0]).toBe(modelRegistry);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves Pi's current-model path when no model is configured", async () => {
    // An absent setting must not resolve a model or replace Pi's native compaction.
    const find = vi.fn();
    const runCompact = vi.fn();
    const registry = createToolRegistry({
      model: currentModel,
      modelRegistry: { find },
    });
    registerCompactionModel(registry.pi as never, () => ({}), runCompact as never);

    const result = await registry.emit("session_before_compact", compactEvent(new AbortController().signal));

    expect(result).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
    expect(runCompact).not.toHaveBeenCalled();
  });

  it("uses the configured model while preserving Pi's native compaction preparation", async () => {
    // Preserve Pi's prepared cut point; request-time credentials and overrides belong to the registry.
    const auth = {
      ok: true as const,
      apiKey: "summary-key",
      headers: { "x-summary": "true", "x-delete": null },
      baseUrl: "https://summary.example/v1",
      env: { SUMMARY_ENV: "1" },
    };
    const find = vi.fn().mockReturnValue(configuredModel);
    const getApiKeyAndHeaders = vi.fn().mockResolvedValue(auth);
    const expected = {
      summary: "## Goal\nContinue the work.",
      firstKeptEntryId: "keep-entry",
      tokensBefore: 1_000,
    };
    const runCompact = vi.fn().mockResolvedValue(expected);
    const registry = createToolRegistry({
      model: currentModel,
      modelRegistry: { find, getApiKeyAndHeaders },
    });
    registerCompactionModel(
      registry.pi as never,
      () => ({
        compactionModel: { provider: "google", modelId: "gemini-2.5-flash" },
        compactionThinkingLevel: "high",
      }),
      runCompact as never,
    );
    const signal = new AbortController().signal;
    const event = compactEvent(signal);

    const result = await registry.emit("session_before_compact", event, { thinkingLevel: "low" });

    expect(result).toEqual({ compaction: expected });
    expect(find).toHaveBeenCalledWith("google", "gemini-2.5-flash");
    expect(getApiKeyAndHeaders).toHaveBeenCalledWith(configuredModel);
    expect(runCompact).toHaveBeenCalledWith(
      event.preparation,
      configuredModel,
      undefined,
      undefined,
      event.customInstructions,
      signal,
      "high",
      expect.any(Function),
    );
  });

  it("inherits the current session thinking level when no compaction override is configured", async () => {
    // Omitting the scoped override should preserve the session's active reasoning level.
    const runCompact = vi.fn().mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "keep-entry",
      tokensBefore: 1_000,
    });
    const registry = createToolRegistry({
      model: currentModel,
      modelRegistry: {
        find: vi.fn().mockReturnValue(configuredModel),
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "summary-key" }),
      },
    });
    registerCompactionModel(
      registry.pi as never,
      () => ({ compactionModel: { provider: "google", modelId: "gemini-2.5-flash" } }),
      runCompact as never,
    );

    await registry.emit(
      "session_before_compact",
      compactEvent(new AbortController().signal),
      { thinkingLevel: "medium" },
    );

    expect(runCompact.mock.calls[0]?.[6]).toBe("medium");
  });

  it("preserves Pi's native path when the configured model is already current", async () => {
    // Matching model and thinking settings should retain native retries and entry metadata.
    const find = vi.fn();
    const runCompact = vi.fn();
    const registry = createToolRegistry({
      model: currentModel,
      modelRegistry: { find },
    });
    registerCompactionModel(
      registry.pi as never,
      () => ({ compactionModel: { provider: "openai", modelId: "gpt-5" } }),
      runCompact as never,
    );

    const result = await registry.emit("session_before_compact", compactEvent(new AbortController().signal));

    expect(result).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
    expect(runCompact).not.toHaveBeenCalled();
  });

  it("applies an explicit thinking override even when the configured model is current", async () => {
    // A scoped reasoning override is meaningful even when no model switch is needed.
    const find = vi.fn();
    const getApiKeyAndHeaders = vi.fn().mockResolvedValue({ ok: true, apiKey: "summary-key" });
    const runCompact = vi.fn().mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "keep-entry",
      tokensBefore: 1_000,
    });
    const registry = createToolRegistry({
      model: currentModel,
      modelRegistry: { find, getApiKeyAndHeaders },
    });
    registerCompactionModel(
      registry.pi as never,
      () => ({
        compactionModel: { provider: "openai", modelId: "gpt-5" },
        compactionThinkingLevel: "high",
      }),
      runCompact as never,
    );

    await registry.emit(
      "session_before_compact",
      compactEvent(new AbortController().signal),
      { thinkingLevel: "low" },
    );

    expect(find).not.toHaveBeenCalled();
    expect(getApiKeyAndHeaders).toHaveBeenCalledWith(currentModel);
    expect(runCompact.mock.calls[0]?.[1]).toBe(currentModel);
    expect(runCompact.mock.calls[0]?.[6]).toBe("high");
  });

  it("cancels before model resolution when the compaction signal is already aborted", async () => {
    // A pre-existing cancellation must not start either the configured or fallback request.
    const controller = new AbortController();
    controller.abort();
    const find = vi.fn();
    const runCompact = vi.fn();
    const registry = createToolRegistry({
      model: currentModel,
      modelRegistry: { find },
    });
    registerCompactionModel(
      registry.pi as never,
      () => ({ compactionModel: { provider: "google", modelId: "gemini-2.5-flash" } }),
      runCompact as never,
    );

    const result = await registry.emit("session_before_compact", compactEvent(controller.signal));

    expect(result).toEqual({ cancel: true });
    expect(find).not.toHaveBeenCalled();
    expect(runCompact).not.toHaveBeenCalled();
  });

  it("cancels instead of falling back when configured-model compaction is aborted", async () => {
    // Cancellation during the target request must not trigger a second request on the session model.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const controller = new AbortController();
    const find = vi.fn().mockReturnValue(configuredModel);
    const runCompact = vi.fn(async () => {
      controller.abort();
      return { summary: "unused", firstKeptEntryId: "keep-entry", tokensBefore: 1_000 };
    });
    const registry = createToolRegistry({
      model: currentModel,
      modelRegistry: {
        find,
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "summary-key" }),
      },
    });
    registerCompactionModel(
      registry.pi as never,
      () => ({ compactionModel: { provider: "google", modelId: "gemini-2.5-flash" } }),
      runCompact as never,
    );

    const result = await registry.emit("session_before_compact", compactEvent(controller.signal));

    expect(result).toEqual({ cancel: true });
    expect(runCompact).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("cancels cleanly when authentication or a rejected target request observes an abort", async () => {
    // Abort races around awaited operations must not warn or fall through to native compaction.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const authController = new AbortController();
    const authAbort = createToolRegistry({
      model: currentModel,
      modelRegistry: {
        find: vi.fn().mockReturnValue(configuredModel),
        getApiKeyAndHeaders: vi.fn(async () => {
          authController.abort();
          return { ok: true, apiKey: "summary-key" };
        }),
      },
    });
    const neverCalled = vi.fn();
    registerCompactionModel(
      authAbort.pi as never,
      () => ({ compactionModel: { provider: "google", modelId: "gemini-2.5-flash" } }),
      neverCalled as never,
    );

    await expect(authAbort.emit("session_before_compact", compactEvent(authController.signal)))
      .resolves.toEqual({ cancel: true });
    expect(neverCalled).not.toHaveBeenCalled();

    const requestController = new AbortController();
    const requestAbort = createToolRegistry({
      model: currentModel,
      modelRegistry: {
        find: vi.fn().mockReturnValue(configuredModel),
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "summary-key" }),
      },
    });
    const rejectedCompact = vi.fn(async () => {
      requestController.abort();
      throw new Error("aborted request");
    });
    registerCompactionModel(
      requestAbort.pi as never,
      () => ({ compactionModel: { provider: "google", modelId: "gemini-2.5-flash" } }),
      rejectedCompact as never,
    );

    await expect(requestAbort.emit("session_before_compact", compactEvent(requestController.signal)))
      .resolves.toEqual({ cancel: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to Pi's current-model path when the configured model is unavailable", async () => {
    // An unresolved target should warn and return no custom result so Pi performs native compaction.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const find = vi.fn().mockReturnValue(undefined);
    const runCompact = vi.fn();
    const registry = createToolRegistry({
      model: currentModel,
      modelRegistry: { find },
    });
    registerCompactionModel(
      registry.pi as never,
      () => ({ compactionModel: { provider: "google", modelId: "gemini-2.5-flash" } }),
      runCompact as never,
    );

    const result = await registry.emit("session_before_compact", compactEvent(new AbortController().signal));

    expect(result).toBeUndefined();
    expect(runCompact).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(registry.getNotifications().at(-1)).toMatchObject({ variant: "warning" });
  });

  it("falls back to Pi's current-model path when configured-model authentication or compaction fails", async () => {
    // Both pre-request and request-time failures must leave the native fallback available.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const authFailure = createToolRegistry({
      model: currentModel,
      modelRegistry: {
        find: vi.fn().mockReturnValue(configuredModel),
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: false, error: "missing credential" }),
      },
    });
    const neverCalled = vi.fn();
    registerCompactionModel(
      authFailure.pi as never,
      () => ({ compactionModel: { provider: "google", modelId: "gemini-2.5-flash" } }),
      neverCalled as never,
    );

    await expect(authFailure.emit("session_before_compact", compactEvent(new AbortController().signal))).resolves.toBeUndefined();
    expect(neverCalled).not.toHaveBeenCalled();

    const failingCompact = vi.fn().mockRejectedValue(new Error("summary unavailable"));
    const requestFailure = createToolRegistry({
      model: currentModel,
      modelRegistry: {
        find: vi.fn().mockReturnValue(configuredModel),
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "summary-key" }),
      },
    });
    registerCompactionModel(
      requestFailure.pi as never,
      () => ({ compactionModel: { provider: "google", modelId: "gemini-2.5-flash" } }),
      failingCompact as never,
    );

    await expect(requestFailure.emit("session_before_compact", compactEvent(new AbortController().signal))).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(authFailure.getNotifications()).toContainEqual({
      message: expect.stringContaining("cannot authenticate"),
      variant: "warning",
    });
    expect(requestFailure.getNotifications()).toContainEqual({
      message: expect.stringContaining("summary unavailable"),
      variant: "warning",
    });
  });
});
