import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoadedPiBaseSettings } from "../config.js";
import type { CollapsedResultLinesResolver, CollapsedResultMaxCharsResolver } from "../render.js";
import { isRootSession, readRootSessionId } from "../subagent/depth.js";
import { McpSessionBinding, type McpSessionBindingOptions } from "./binding.js";
import type { McpHub, McpHubOptions } from "./hub.js";
import { processMcpHubRegistry, type McpHubLease } from "./registry.js";
import { renderMcpFooterStatus, renderMcpStatusTree } from "./status.js";
import type { McpSnapshot } from "./types.js";

export const PI_BASE_MCP_STATUS_KEY = "02-pi-base-mcp";
const MCP_STATUS_MESSAGE_TYPE = "pi-base-mcp-status";

export interface RegisterMcpSupportOptions
  extends McpHubOptions,
  Pick<McpSessionBindingOptions, "canActivateTool" | "onToolAvailabilityChange"> {
  loadSettings?: (cwd: string) => LoadedPiBaseSettings;
  getCollapsedResultLines?: CollapsedResultLinesResolver;
  getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver;
  /** Test/custom integration hook. Production sessions acquire a root-scoped process hub. */
  hub?: McpHub;
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

  const hubOptions: McpHubOptions = {
    clientFactory: options.clientFactory,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    retryDelaysMs: options.retryDelaysMs,
    callWaitTimeoutMs: options.callWaitTimeoutMs,
  };
  let started = false;
  let startPromise: Promise<void> | undefined;
  let generation = 0;
  let binding: McpSessionBinding | undefined;
  type ActiveBinding = {
    binding: McpSessionBinding;
    rootSessionId: string;
    lease?: McpHubLease;
  };
  let active: ActiveBinding | undefined;

  const getBinding = (hub: McpHub) => {
    if (!binding) {
      binding = new McpSessionBinding({
        hub,
        pi,
        getCollapsedResultLines: options.getCollapsedResultLines,
        getCollapsedResultMaxChars: options.getCollapsedResultMaxChars,
        canActivateTool: options.canActivateTool,
        onToolAvailabilityChange: options.onToolAvailabilityChange,
        onSnapshotChange: (snapshot, ctx) => {
          if (!ctx.hasUI) return;
          ctx.ui.setStatus(PI_BASE_MCP_STATUS_KEY, renderMcpFooterStatus(snapshot));
        },
      });
    } else {
      binding.setHub(hub);
    }
    return binding;
  };
  const emptySnapshot = (): McpSnapshot => ({ enabledServers: 0, connectedServers: 0, servers: [] });

  const prepareBinding = async (ctx: ExtensionContext, startGeneration: number): Promise<ActiveBinding | undefined> => {
    const rootSessionId = readRootSessionId(ctx);
    if (active && !options.hub && active.rootSessionId !== rootSessionId) {
      const previous = active;
      active = undefined;
      previous.lease?.markTerminal();
      try {
        await previous.binding.stop();
      } finally {
        await previous.lease?.release();
      }
      if (generation !== startGeneration) return undefined;
    }
    if (generation !== startGeneration) return undefined;
    if (!active) {
      const lease = options.hub ? undefined : processMcpHubRegistry.acquire(rootSessionId);
      if (generation !== startGeneration) {
        await lease?.abandon();
        return undefined;
      }
      try {
        active = {
          binding: getBinding(options.hub ?? lease!.hub),
          rootSessionId,
          lease,
        };
      } catch (error) {
        await lease?.abandon();
        throw error;
      }
    }
    return active;
  };

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
        content: renderMcpStatusTree(active?.binding.getSnapshot() ?? emptySnapshot()),
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
    const config = options.loadSettings!(ctx.cwd).settings.mcp;
    startPromise = prepareBinding(ctx, startGeneration)
      .then((prepared) => {
        if (!prepared || generation !== startGeneration) return;
        return prepared.binding.start(ctx, config, hubOptions);
      })
      .then(() => {
        if (generation === startGeneration) started = true;
      })
      .finally(() => {
        if (generation === startGeneration) startPromise = undefined;
      });
    return startPromise;
  });

  pi.on("session_shutdown", async (event, ctx) => {
    generation++;
    started = false;
    startPromise = undefined;
    const current = active;
    active = undefined;
    if (!current) return;
    const terminal = isRootSession(ctx) && event.reason !== "reload";
    if (terminal) {
      if (options.hub) options.hub.requestShutdownWhenUnused();
      else current.lease?.markTerminal();
    }
    try {
      await current.binding.stop();
    } finally {
      await current.lease?.release();
    }
  });
}
