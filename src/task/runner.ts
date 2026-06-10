import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { subagentActivityStore } from "./activity.js";
import { buildSubagentSystemPrompt } from "./prompt.js";
import { getSubagentConfig, loadSubagentRegistry } from "./registry.js";
import { buildFinalContent, buildRunDetails, createSubagentLoader, getFinalAssistantText, getTerminalAssistantFailure, resolveSubagentModel } from "./runtime.js";
import { appendSubagentInvocation, createSubagentSessionManager, openSubagentSessionManager } from "./sessions.js";
import type { AgentSessionLike, SubagentRunDetails } from "./types.js";

type TaskToolResult = AgentToolResult<SubagentRunDetails> & { isError?: boolean };

function buildFailureResult(name: string, mode: "new" | "resume", message: string, summaryLine: string): TaskToolResult {
  const details: SubagentRunDetails = {
    mode,
    name,
    status: "failed",
    tailLines: [summaryLine, `Error: ${message}`],
    summary: summaryLine,
    transcriptLines: ["Error:", message],
    error: message,
  };
  return {
    content: [{ type: "text", text: buildFinalContent(details, message) }],
    details,
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
  onUpdate?: (partialResult: TaskToolResult) => void;
  createSession?: typeof createAgentSession;
}

export async function executeSubagent(options: ExecuteSubagentOptions): Promise<TaskToolResult> {
  const mode = options.sessionId ? "resume" : "new";
  const registry = loadSubagentRegistry(options.ctx.cwd);
  if (registry.size === 0) {
    return buildFailureResult(options.name, mode, "No subagents are configured.", "(no subagents configured)");
  }

  const config = getSubagentConfig(registry, options.name);
  if (!config) {
    const available = Array.from(registry.values()).map((item) => item.name).sort().join(", ") || "none";
    return buildFailureResult(options.name, mode, `unknown subagent "${options.name}". Available subagents: ${available}.`, "(unknown subagent)");
  }

  const resolvedModel = resolveSubagentModel(config, options.ctx);
  if (resolvedModel.error) {
    return buildFailureResult(config.name, mode, resolvedModel.error, "(invalid subagent model)");
  }

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
    const currentParentSessionPath = options.ctx.sessionManager.getSessionFile();
    const sessionManager = options.sessionId
      ? await openSubagentSessionManager(options.ctx.cwd, options.sessionId, getAgentDir(), parentSessionDir, currentParentSessionPath)
      : createSubagentSessionManager(options.ctx.cwd, currentParentSessionPath, getAgentDir(), parentSessionDir);
    parentSessionPath = sessionManager.getHeader()?.parentSession;

    const loader = createSubagentLoader(options.ctx.cwd, buildSubagentSystemPrompt(config, options.ctx.cwd));
    await loader.reload();

    const created = await (options.createSession ?? createAgentSession)({
      cwd: options.ctx.cwd,
      agentDir: getAgentDir(),
      modelRegistry: options.ctx.modelRegistry,
      model: resolvedModel.model,
      thinkingLevel: config.thinking ?? options.pi.getThinkingLevel(),
      tools: Array.from(new Set(config.tools)),
      resourceLoader: loader,
      sessionManager,
      settingsManager: SettingsManager.create(options.ctx.cwd, getAgentDir()),
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
      const details = buildRunDetails(session, { mode, name: config.name, status, error }, {
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
      if (event.type === "turn_end" || event.type === "queue_update") emitPartial("running");
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
    const terminalFailure = getTerminalAssistantFailure(session.messages);
    const status = terminalFailure ? "failed" : "completed";
    const details = buildRunDetails(session, {
      mode,
      name: config.name,
      status,
      ...(terminalFailure ? { error: terminalFailure } : {}),
    }, {
      responseText,
      activeTools: [...activeTools],
    });
    subagentActivityStore.finish({ ...details, parentSessionPath });
    return {
      content: [{ type: "text", text: buildFinalContent(details, terminalFailure ?? getFinalAssistantText(session.messages)) }],
      details,
      ...(terminalFailure ? { isError: true } : {}),
    };
  } catch (error) {
    if (!session) {
      return buildFailureResult(config.name, mode, (error as Error).message, "(subagent failed to start)");
    }
    const details = buildRunDetails(session, {
      mode,
      name: config.name,
      status: "failed",
      error: (error as Error).message,
    }, {
      responseText,
      activeTools: [...activeTools],
    });
    subagentActivityStore.finish({ ...details, parentSessionPath });
    return {
      content: [{ type: "text", text: buildFinalContent(details, (error as Error).message) }],
      details,
      isError: true,
    };
  } finally {
    unsubscribe?.();
    cleanupAbort?.();
    session?.dispose();
  }
}
