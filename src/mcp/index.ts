import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadedPiBaseSettings } from "../config.js";
import { createMcpManager, type McpManagerOptions } from "./manager.js";
import { renderMcpFooterStatus, renderMcpStatusTree } from "./status.js";

export const PI_BASE_MCP_STATUS_KEY = "pi-base-mcp";
const MCP_STATUS_MESSAGE_TYPE = "pi-base-mcp-status";

export interface RegisterMcpSupportOptions extends Pick<McpManagerOptions, "clientFactory" | "heartbeatIntervalMs" | "retryDelaysMs" | "callWaitTimeoutMs"> {
  loadSettings?: (cwd: string) => LoadedPiBaseSettings;
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
    onSnapshotChange: (snapshot, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.setStatus(PI_BASE_MCP_STATUS_KEY, renderMcpFooterStatus(snapshot));
    },
  });

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

  pi.on("session_start", async (_event, ctx) => {
    void manager.start(ctx, pi);
  });
  pi.on("session_shutdown", async () => {
    await manager.shutdown();
  });
}
