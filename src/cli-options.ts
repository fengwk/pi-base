import { parseArgs, resolveCliModel, type Args, type ExtensionContext, type ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface StartupCliOverrides {
  hasModel: boolean;
  thinkingLevel?: Args["thinking"];
}

export function getStartupCliOverrides(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): StartupCliOverrides {
  // Built-in flags are not exposed by ExtensionAPI.getFlag(). Use Pi's parser so
  // positional arguments and other options' values aren't mistaken for flags.
  const { model, provider, thinking, apiKey } = parseArgs(process.argv.slice(2));
  if (thinking !== undefined || !model?.includes(":") || !ctx.model) {
    return { hasModel: Boolean(model), thinkingLevel: thinking };
  }

  // Pi's resolver distinguishes thinking shorthand from literal model IDs. It only
  // needs these two catalog methods, available through the extension's ModelRegistry.
  const models = ctx.modelRegistry.getAll();
  const modelCatalog: Pick<ModelRuntime, "getModels" | "hasConfiguredAuth"> = {
    getModels: () => models,
    hasConfiguredAuth: (providerId) => {
      const entry = models.find((candidate) => candidate.provider === providerId);
      return entry !== undefined && ctx.modelRegistry.hasConfiguredAuth(entry);
    },
  };
  const options = {
    cliProvider: provider,
    cliModel: model,
    inlineApiKey: Boolean(apiKey),
    modelRuntime: modelCatalog as ModelRuntime,
  };
  const resolved = resolveCliModel(options);
  const matchesActiveModel = resolved.model?.provider === ctx.model.provider && resolved.model.id === ctx.model.id;
  return { hasModel: true, thinkingLevel: matchesActiveModel ? resolved.thinkingLevel : undefined };
}
