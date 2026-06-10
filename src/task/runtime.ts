import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildTranscriptLines, getFinalAssistantText, summarizeTailLines } from "./transcript.js";
import type { AgentSessionLike, SubagentConfig, SubagentRunDetails } from "./types.js";

const SELF_EXTENSION_PATH = fileURLToPath(new URL("../../index.ts", import.meta.url));

type ModelRegistryLike = {
  find(provider: string, modelId: string): Model<any> | undefined;
  getAvailable(): Model<any>[];
  getAll?(): Model<any>[];
};

function extensionCanonicalName(extensionPath: string): string {
  const base = basename(extensionPath);
  return (base === "index.ts" || base === "index.js"
    ? basename(dirname(extensionPath))
    : base.replace(/\.(ts|js)$/, "")
  ).toLowerCase();
}

export function buildFinalContent(details: SubagentRunDetails, finalText: string): string {
  const body = finalText.trim() || details.error?.trim() || "(no output)";
  const statusLine = details.status === "running"
    ? `subagent ${details.name} is still running.`
    : details.status === "failed"
      ? `subagent ${details.name} run failed.`
      : `subagent ${details.name} run completed.`;
  const bodyLabel = details.status === "running"
    ? "latest_update"
    : details.status === "failed"
      ? "error"
      : undefined;
  return [
    statusLine,
    ...(details.sessionId ? [`session_id: \`${details.sessionId}\``] : []),
    "",
    ...(bodyLabel ? [`${bodyLabel}:`] : []),
    body,
  ].join("\n");
}

export function getTerminalAssistantFailure(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
    if (!message || typeof message !== "object" || message.role !== "assistant") continue;
    const errorMessage = typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
      ? message.errorMessage.trim()
      : undefined;
    if (message.stopReason === "aborted") return errorMessage || "Operation aborted";
    if (message.stopReason === "error") return errorMessage || "Subagent failed";
    return undefined;
  }
  return undefined;
}

export function buildRunDetails(
  session: Pick<AgentSessionLike, "messages" | "sessionFile" | "sessionId">,
  base: Pick<SubagentRunDetails, "mode" | "name" | "status" | "error">,
  options: { responseText?: string; activeTools?: string[] } = {},
): SubagentRunDetails {
  const transcriptLines = buildTranscriptLines(session.messages, options);
  const recentLines = transcriptLines
    .filter((line) => line.trim().length > 0)
    .slice(-(base.error ? 9 : 10));
  const tailLines = recentLines.length > 0 ? [...recentLines] : [];
  if (base.error) tailLines.push(`Error: ${base.error}`);
  if (tailLines.length === 0) tailLines.push("(waiting for output...)");
  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    mode: base.mode,
    name: base.name,
    status: base.status,
    tailLines,
    summary: summarizeTailLines(tailLines),
    transcriptLines,
    ...(base.error ? { error: base.error } : {}),
  };
}

export function createSubagentLoader(cwd: string, systemPrompt: string) {
  const agentDir = getAgentDir();
  const keepName = extensionCanonicalName(SELF_EXTENSION_PATH);
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [SELF_EXTENSION_PATH],
    extensionsOverride: (base) => {
      const seen = new Set<string>();
      return {
        ...base,
        extensions: base.extensions.filter((extension) => {
          const name = extensionCanonicalName(extension.path);
          if (name !== keepName || seen.has(name)) return false;
          seen.add(name);
          return true;
        }),
      };
    },
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
}

function resolveConfiguredModel(input: string, registry: ModelRegistryLike): { model?: Model<any>; error?: string } {
  const models = registry.getAvailable?.() ?? registry.getAll?.() ?? [];
  if (models.length === 0) {
    return { error: `Model not found: "${input}". No available models are configured.` };
  }

  const normalizedInput = input.trim().toLowerCase();
  const exact = models.find((model) => {
    const full = `${model.provider}/${model.id}`.toLowerCase();
    return full === normalizedInput || model.id.toLowerCase() === normalizedInput;
  });
  if (exact) {
    return { model: registry.find(exact.provider, exact.id) ?? exact };
  }

  const fuzzy = models.find((model) => {
    const full = `${model.provider}/${model.id}`.toLowerCase();
    const name = String((model as { name?: unknown }).name ?? "").toLowerCase();
    return full.includes(normalizedInput) || model.id.toLowerCase().includes(normalizedInput) || name.includes(normalizedInput);
  });
  if (fuzzy) {
    return { model: registry.find(fuzzy.provider, fuzzy.id) ?? fuzzy };
  }

  const available = models.map((model) => `  ${model.provider}/${model.id}`).sort().join("\n");
  return { error: `Model not found: "${input}".\n\nAvailable models:\n${available}` };
}

export function resolveSubagentModel(config: SubagentConfig, ctx: ExtensionContext): { model?: Model<any>; error?: string } {
  if (!config.model) return { model: ctx.model };
  const registry = ctx.modelRegistry as unknown as ModelRegistryLike | undefined;
  if (!registry || typeof registry.find !== "function" || typeof registry.getAvailable !== "function") {
    return { error: "Subagent model resolution requires a model registry, but the runtime did not provide one." };
  }
  return resolveConfiguredModel(config.model, registry);
}

export { getFinalAssistantText };
