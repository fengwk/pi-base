import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { subagentActivityStore } from "./activity.js";
import { buildSubagentSystemPrompt } from "./prompt.js";
import { getSubagentConfig, loadSubagentRegistry, normalizeSubagentName } from "./registry.js";
import { appendSubagentInvocation, createSubagentSessionManager, getLatestSubagentInvocation, openSubagentSessionManager } from "./sessions.js";
import { buildTailLines, getFinalAssistantText, summarizeTailLines } from "./transcript.js";
import type { AgentSessionLike, SubagentConfig, SubagentToolDetails } from "./types.js";

const SELF_EXTENSION_PATH = fileURLToPath(new URL("../../index.ts", import.meta.url));

type SubagentToolResult = AgentToolResult<SubagentToolDetails> & { isError?: boolean };

function extensionCanonicalName(extensionPath: string): string {
  const base = basename(extensionPath);
  return (base === "index.ts" || base === "index.js"
    ? basename(dirname(extensionPath))
    : base.replace(/\.(ts|js)$/, "")
  ).toLowerCase();
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function buildFinalContent(details: SubagentToolDetails, finalText: string): string {
  const sections = [
    details.sessionId ? `session_id: ${details.sessionId}` : undefined,
    `name: ${details.name}`,
    `status: ${details.status}`,
    "",
    finalText.trim() || details.error || "(no output)",
  ].filter((value): value is string => value !== undefined);
  return sections.join("\n");
}

function buildDetails(
  session: Pick<AgentSessionLike, "messages" | "sessionFile" | "sessionId">,
  base: Pick<SubagentToolDetails, "mode" | "name" | "status" | "error">,
  options: { responseText?: string; activeTools?: string[] } = {},
): SubagentToolDetails {
  const tailLines = buildTailLines(session.messages, options, 10);
  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    mode: base.mode,
    name: base.name,
    status: base.status,
    tailLines,
    summary: summarizeTailLines(tailLines),
    ...(base.error ? { error: base.error } : {}),
  };
}

function getCallerConfigName(ctx: ExtensionContext): string | undefined {
  const latest = getLatestSubagentInvocation(ctx.sessionManager.getEntries());
  return latest?.name?.trim() || undefined;
}

export function assertSubagentAllowed(
  ctx: ExtensionContext,
  registry: Map<string, SubagentConfig>,
  targetName: string,
): void {
  const callerName = getCallerConfigName(ctx);
  if (!callerName) return;
  const callerConfig = getSubagentConfig(registry, callerName);
  if (!callerConfig || callerConfig.subagents.length === 0) return;
  const allowed = callerConfig.subagents.map(normalizeSubagentName);
  if (allowed.includes(normalizeSubagentName(targetName))) return;
  throw new Error(`Subagent "${callerName}" is not allowed to invoke "${targetName}".`);
}

function createLoader(cwd: string, systemPrompt: string) {
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

function buildFailureResult(name: string, mode: "new" | "resume", message: string, summaryLine: string): SubagentToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: {
      mode,
      name,
      status: "failed",
      tailLines: [summaryLine],
      summary: summaryLine,
      error: message,
    },
    isError: true,
  };
}

export interface ExecuteSubagentOptions {
  pi: Pick<ExtensionAPI, "getThinkingLevel">;
  ctx: ExtensionContext;
  name: string;
  prompt: string;
  sessionId?: string;
  signal?: AbortSignal;
  onUpdate?: (partialResult: SubagentToolResult) => void;
  createSession?: typeof createAgentSession;
}

export async function executeSubagent(options: ExecuteSubagentOptions): Promise<SubagentToolResult> {
  const mode = options.sessionId ? "resume" : "new";
  const registry = loadSubagentRegistry(options.ctx.cwd);
  if (registry.size === 0) {
    return buildFailureResult(options.name, mode, "No subagents are configured.", "(no subagents configured)");
  }

  const config = getSubagentConfig(registry, options.name);
  if (!config) {
    const available = Array.from(registry.values()).map((item) => item.name).sort().join(", ") || "none";
    return buildFailureResult(options.name, mode, `unknown subagent \"${options.name}\". Available subagents: ${available}.`, "(unknown subagent)");
  }

  try {
    assertSubagentAllowed(options.ctx, registry, config.name);
  } catch (error) {
    return buildFailureResult(config.name, mode, (error as Error).message, "(subagent not allowed)");
  }

  const agentDir = getAgentDir();
  let session: AgentSessionLike | undefined;
  let unsubscribe: (() => void) | undefined;
  let cleanupAbort: (() => void) | undefined;
  let parentSessionPath: string | undefined;
  let responseText = "";
  const activeTools = new Set<string>();

  try {
    const parentSessionDir = typeof options.ctx.sessionManager.getSessionDir === "function"
      ? options.ctx.sessionManager.getSessionDir()
      : undefined;
    const sessionManager = options.sessionId
      ? await openSubagentSessionManager(options.ctx.cwd, options.sessionId, agentDir, parentSessionDir)
      : createSubagentSessionManager(options.ctx.cwd, options.ctx.sessionManager.getSessionFile(), agentDir, parentSessionDir);
    parentSessionPath = sessionManager.getHeader()?.parentSession;
    const systemPrompt = buildSubagentSystemPrompt(config, registry, options.ctx.cwd);
    const loader = createLoader(options.ctx.cwd, systemPrompt);
    await loader.reload();

    const allowedTools = unique([
      ...config.tools,
      ...(config.subagents.length > 0 ? ["subagent"] : []),
    ]);

    const createSession = options.createSession ?? createAgentSession;
    const created = await createSession({
      cwd: options.ctx.cwd,
      agentDir,
      modelRegistry: options.ctx.modelRegistry,
      model: options.ctx.model,
      thinkingLevel: options.pi.getThinkingLevel(),
      tools: allowedTools,
      resourceLoader: loader,
      sessionManager,
      settingsManager: SettingsManager.create(options.ctx.cwd, agentDir),
    });

    session = created.session as AgentSessionLike;
    await session.bindExtensions({});
    session.setSessionName(config.name);
    appendSubagentInvocation(session.sessionManager, {
      name: config.name,
      timestamp: new Date().toISOString(),
      parentSessionId: options.ctx.sessionManager.getSessionId(),
      callerSessionId: options.ctx.sessionManager.getSessionId(),
    });

    const emitPartial = (status: "running" | "completed" | "failed", error?: string) => {
      if (!session) return;
      const details = buildDetails(session, { mode, name: config.name, status, error }, {
        responseText,
        activeTools: [...activeTools],
      });
      subagentActivityStore.upsert({
        ...details,
        parentSessionPath,
        currentResponseText: responseText,
        activeTools: [...activeTools],
        session,
      });
      options.onUpdate?.({
        content: [{ type: "text", text: buildFinalContent(details, status === "running" ? details.summary : getFinalAssistantText(session.messages)) }],
        details,
        ...(status === "failed" ? { isError: true } : {}),
      });
    };

    emitPartial("running");
    unsubscribe = session.subscribe((event) => {
      if (event.type === "message_start") {
        responseText = "";
        emitPartial("running");
        return;
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        responseText += event.assistantMessageEvent.delta;
        emitPartial("running");
        return;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        responseText = "";
        emitPartial("running");
        return;
      }
      if (event.type === "tool_execution_start") {
        activeTools.add(event.toolName);
        emitPartial("running");
        return;
      }
      if (event.type === "tool_execution_end") {
        activeTools.delete(event.toolName);
        emitPartial("running");
        return;
      }
      if (event.type === "turn_end" || event.type === "queue_update") {
        emitPartial("running");
      }
    });

    if (options.signal) {
      const onAbort = () => {
        void session?.abort();
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
      cleanupAbort = () => options.signal?.removeEventListener("abort", onAbort);
    }

    await session.prompt(options.prompt);
    const details = buildDetails(session, { mode, name: config.name, status: "completed" });
    subagentActivityStore.finish({ ...details, parentSessionPath });
    return {
      content: [{ type: "text", text: buildFinalContent(details, getFinalAssistantText(session.messages)) }],
      details,
    };
  } catch (error) {
    if (!session) {
      return buildFailureResult(config.name, mode, (error as Error).message, "(subagent failed to start)");
    }
    const message = (error as Error).message;
    const details = buildDetails(session, { mode, name: config.name, status: "failed", error: message }, {
      responseText,
      activeTools: [...activeTools],
    });
    subagentActivityStore.finish({ ...details, parentSessionPath });
    return {
      content: [{ type: "text", text: buildFinalContent(details, message) }],
      details,
      isError: true,
    };
  } finally {
    unsubscribe?.();
    cleanupAbort?.();
    session?.dispose();
  }
}
