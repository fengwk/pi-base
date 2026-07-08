import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadedPiBaseSettings } from "../config.js";
import type { CollapsedResultLinesResolver, CollapsedResultMaxCharsResolver } from "../render.js";
import { createMcpManager, type McpManagerOptions } from "./manager.js";
import { renderMcpFooterStatus, renderMcpStatusTree } from "./status.js";

export const PI_BASE_MCP_STATUS_KEY = "02-pi-base-mcp";
const MCP_STATUS_MESSAGE_TYPE = "pi-base-mcp-status";

export interface RegisterMcpSupportOptions extends Pick<McpManagerOptions, "clientFactory" | "heartbeatIntervalMs" | "retryDelaysMs" | "callWaitTimeoutMs" | "canActivateTool" | "onToolAvailabilityChange"> {
  loadSettings?: (cwd: string) => LoadedPiBaseSettings;
  getCollapsedResultLines?: CollapsedResultLinesResolver;
  getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver;
}

export function registerMcpSupport(
  pi: Pick<
    ExtensionAPI,
    | "on"
    | "registerCommand"
    | "registerMessageRenderer"
    | "sendMessage"
    | "registerTool"
    | "getAllTools"
    | "getActiveTools"
    | "setActiveTools"
  >,
  options: RegisterMcpSupportOptions = {},
): void {
  if (!options.loadSettings) {
    throw new Error("registerMcpSupport requires loadSettings.");
  }

  const manager = createMcpManager({
    loadSettings: options.loadSettings,
    clientFactory: options.clientFactory,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    retryDelaysMs: options.retryDelaysMs,
    callWaitTimeoutMs: options.callWaitTimeoutMs,
    getCollapsedResultLines: options.getCollapsedResultLines,
    getCollapsedResultMaxChars: options.getCollapsedResultMaxChars,
    canActivateTool: options.canActivateTool,
    onToolAvailabilityChange: options.onToolAvailabilityChange,
    onSnapshotChange: (snapshot, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.setStatus(PI_BASE_MCP_STATUS_KEY, renderMcpFooterStatus(snapshot));
    },
  });
  let started = false;
  let startPromise: Promise<void> | undefined;
  let generation = 0;

  pi.registerMessageRenderer(MCP_STATUS_MESSAGE_TYPE, (message) => new Text(String(message.content ?? ""), 0, 0));
  pi.registerCommand("mcp-status", {
    description: "Show MCP server status and discovered tools",
    handler: async (args, ctx) => {
      if (args.trim().length > 0) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /mcp-status", "warning");
        return;
      }

      pi.sendMessage({
        customType: MCP_STATUS_MESSAGE_TYPE,
        content: renderMcpStatusTree(manager.getSnapshot()),
        display: true,
      });
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const isReload = event.reason === "reload";
    if (!isReload && started) return;
    if (!isReload && startPromise) return startPromise;
    const startGeneration = ++generation;
    started = false;
    startPromise = manager.start(ctx, pi)
      .then(() => {
        if (generation === startGeneration) started = true;
      })
      .finally(() => {
        if (generation === startGeneration) startPromise = undefined;
      });
    return startPromise;
  });
  pi.on("session_shutdown", async () => {
    generation++;
    started = false;
    startPromise = undefined;
    await manager.shutdown();
  });
}
