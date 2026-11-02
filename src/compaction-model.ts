import { compact, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionModelConfig, CompactionThinkingLevel, PiBaseSettings } from "./config.js";
import { reportRuntimeWarning } from "./runtime-diagnostics.js";

type CompactRunner = typeof compact;
type CompactionModelSettings = Pick<PiBaseSettings, "compactionModel" | "compactionThinkingLevel">;

function usesCurrentModel(ctx: ExtensionContext, configured: CompactionModelConfig): boolean {
  return ctx.model?.provider === configured.provider && ctx.model.id === configured.modelId;
}

function canUseNativeCompaction(
  ctx: ExtensionContext,
  configured: CompactionModelConfig,
  configuredThinkingLevel: CompactionThinkingLevel | undefined,
): boolean {
  return usesCurrentModel(ctx, configured)
    && (configuredThinkingLevel === undefined || configuredThinkingLevel === ctx.thinkingLevel);
}

function warnFallback(ctx: ExtensionContext, message: string): void {
  reportRuntimeWarning(ctx, message, `pi-base compaction model: ${message}`);
}

/**
 * Replaces Pi's summarization request when the configured model or thinking level differs.
 * Returning undefined preserves Pi's native current-model compaction path.
 */
export function registerCompactionModel(
  pi: Pick<ExtensionAPI, "on">,
  getConfiguredSettings: (cwd: string) => CompactionModelSettings,
  runCompact: CompactRunner = compact,
): void {
  pi.on("session_before_compact", async (event, ctx) => {
    const { compactionModel: configured, compactionThinkingLevel } = getConfiguredSettings(ctx.cwd);
    if (!configured || canUseNativeCompaction(ctx, configured, compactionThinkingLevel)) return undefined;
    if (event.signal.aborted) return { cancel: true };

    const model = usesCurrentModel(ctx, configured)
      ? ctx.model
      : ctx.modelRegistry.find(configured.provider, configured.modelId);
    if (!model) {
      warnFallback(
        ctx,
        `Compaction model ${configured.provider}/${configured.modelId} is unavailable; using the current session model.`,
      );
      return undefined;
    }

    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (event.signal.aborted) return { cancel: true };
      if (!auth.ok) {
        warnFallback(
          ctx,
          `Compaction model ${configured.provider}/${configured.modelId} cannot authenticate: ${auth.error}. Using the current session model.`,
        );
        return undefined;
      }
      // Resolve request auth through the session runtime, just like ordinary prompts.
      // Replaying auth.apiKey would turn a stored OAuth token into an explicit API key.
      const result = await runCompact(
        event.preparation,
        model,
        undefined,
        undefined,
        event.customInstructions,
        event.signal,
        compactionThinkingLevel ?? ctx.thinkingLevel,
        (requestModel, context, options) => ctx.modelRegistry.streamSimple(requestModel, context, options),
      );
      if (event.signal.aborted) return { cancel: true };
      return { compaction: result };
    } catch (error) {
      if (event.signal.aborted) return { cancel: true };
      const message = error instanceof Error ? error.message : String(error);
      warnFallback(
        ctx,
        `Compaction model ${configured.provider}/${configured.modelId} failed: ${message}. Using the current session model.`,
      );
      return undefined;
    }
  });
}
