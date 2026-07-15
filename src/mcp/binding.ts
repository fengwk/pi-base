import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CollapsedResultLinesResolver, CollapsedResultMaxCharsResolver } from "../render.js";
import { withPiBaseErrorMarker } from "../tool-error-marker.js";
import { buildMcpToolName, createMcpToolDefinition, resolveMcpToolPrefix } from "./adapter.js";
import type { McpHub, McpHubOptions, McpHubSnapshot } from "./hub.js";
import type { McpConfig, McpServerSnapshot, McpSnapshot, McpToolSnapshot } from "./types.js";

type SessionPi = Pick<ExtensionAPI, "registerTool" | "getAllTools" | "getActiveTools" | "setActiveTools">;

export interface McpSessionBindingOptions {
  hub: McpHub;
  pi: SessionPi;
  getCollapsedResultLines?: CollapsedResultLinesResolver;
  getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver;
  canActivateTool?: (toolName: string) => boolean;
  onToolAvailabilityChange?: (toolName: string, available: boolean) => void;
  onSnapshotChange?: (snapshot: McpSnapshot, ctx: ExtensionContext) => void;
}

export class McpSessionBinding {
  private readonly toolOwners = new Map<string, string>();
  private readonly availableAliases = new Set<string>();
  private readonly unavailableAliases = new Set<string>();
  private readonly reactivateWhenAvailable = new Set<string>();
  private releaseHub: (() => Promise<void>) | undefined;
  private ctx: ExtensionContext | undefined;
  private snapshot: McpSnapshot = { enabledServers: 0, connectedServers: 0, servers: [] };

  constructor(private readonly options: McpSessionBindingOptions) {}

  async start(ctx: ExtensionContext, config: McpConfig | undefined, hubOptions: McpHubOptions): Promise<void> {
    await this.stop();
    this.ctx = ctx;
    const attachment = this.options.hub.attach((snapshot) => this.sync(snapshot));
    this.releaseHub = attachment.release;
    try {
      await this.options.hub.configure(config, hubOptions);
      if (this.releaseHub === attachment.release) this.sync(this.options.hub.getSnapshot());
    } catch (error) {
      const cleanup = this.releaseHub === attachment.release ? this.stop() : attachment.release();
      await cleanup.catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const aliases = new Set(this.snapshot.servers.flatMap((server) => server.tools
      .filter((tool) => tool.state !== "conflict")
      .map((tool) => tool.aliasName)));
    const currentlyActiveTools = new Set(this.options.pi.getActiveTools());
    for (const alias of this.availableAliases) {
      this.unavailableAliases.add(alias);
      if (currentlyActiveTools.has(alias)) this.reactivateWhenAvailable.add(alias);
      else this.reactivateWhenAvailable.delete(alias);
    }
    this.reconcileActiveTools(new Set(), aliases);
    for (const alias of this.availableAliases) this.reportToolAvailability(alias, false);
    this.availableAliases.clear();
    this.snapshot = { enabledServers: 0, connectedServers: 0, servers: [] };
    const ctx = this.ctx;
    this.ctx = undefined;
    if (ctx) this.notifySnapshot(this.snapshot, ctx);
    const release = this.releaseHub;
    this.releaseHub = undefined;
    await release?.();
  }

  getSnapshot(): McpSnapshot {
    return this.snapshot;
  }

  private sync(hubSnapshot: McpHubSnapshot): void {
    const pi = this.options.pi;
    const canActivateTool = this.options.canActivateTool ?? (() => true);
    const advertisedAliasOwners = new Map<string, Set<string>>();
    for (const server of hubSnapshot.servers) {
      for (const { tool, stale } of server.tools) {
        if (stale) continue;
        const aliasName = buildMcpToolName(server.key, tool.name, server.config.toolPrefix);
        const owners = advertisedAliasOwners.get(aliasName) ?? new Set<string>();
        owners.add(server.key);
        advertisedAliasOwners.set(aliasName, owners);
      }
    }
    const existingToolNames = new Set(pi.getAllTools().map((tool: { name: string }) => tool.name));
    const currentlyActiveTools = new Set(pi.getActiveTools());
    const activationCandidates = new Set<string>();
    const aliasesToDeactivate = new Set<string>();
    const nextAvailableAliases = new Set<string>();
    const servers: McpServerSnapshot[] = [];

    for (const server of hubSnapshot.servers) {
      const tools: McpToolSnapshot[] = [];
      for (const { tool, stale } of server.tools) {
        const aliasName = buildMcpToolName(server.key, tool.name, server.config.toolPrefix);
        const owner = this.toolOwners.get(aliasName);
        const registeredByThisServer = owner === server.key;
        const ownedByUnavailableServer = owner !== undefined
          && owner !== server.key
          && !advertisedAliasOwners.get(aliasName)?.has(owner);
        const conflictsWithExistingTool = !registeredByThisServer && !ownedByUnavailableServer && existingToolNames.has(aliasName);

        if (!stale && conflictsWithExistingTool) {
          tools.push({
            remoteName: tool.name,
            aliasName,
            description: tool.description,
            state: "conflict",
            reason: owner && owner !== server.key ? `already registered by ${owner}` : "tool name already exists",
          });
          continue;
        }

        if (!stale) {
          pi.registerTool(withPiBaseErrorMarker(createMcpToolDefinition({
            serverKey: server.key,
            serverConfig: server.config,
            tool,
            callTool: (serverKey, toolName, args, _ctx, signal) => this.options.hub.call(serverKey, toolName, args, signal),
            getCollapsedResultLines: this.options.getCollapsedResultLines,
            getCollapsedResultMaxChars: this.options.getCollapsedResultMaxChars,
          })));
          this.toolOwners.set(aliasName, server.key);
          existingToolNames.add(aliasName);
          nextAvailableAliases.add(aliasName);
          const newlyAvailable = !this.availableAliases.has(aliasName);
          const returningFromUnavailable = this.unavailableAliases.has(aliasName);
          const restoringPreviousActiveState = this.reactivateWhenAvailable.has(aliasName);
          const preservingActiveOwnerTransfer = ownedByUnavailableServer && currentlyActiveTools.has(aliasName);
          if ((newlyAvailable && (!returningFromUnavailable || restoringPreviousActiveState)) || preservingActiveOwnerTransfer) {
            activationCandidates.add(aliasName);
          }
        } else if (registeredByThisServer) {
          aliasesToDeactivate.add(aliasName);
        }

        tools.push({
          remoteName: tool.name,
          aliasName,
          description: tool.description,
          state: stale ? "stale" : "registered",
        });
      }

      servers.push({
        key: server.key,
        enabled: server.config.enabled !== false,
        state: server.state,
        type: server.config.type,
        transport: server.config.type === "remote" ? server.config.transport : undefined,
        prefix: resolveMcpToolPrefix(server.key, server.config.toolPrefix),
        lastError: server.lastError,
        nextRetryInMs: server.nextRetryInMs,
        tools,
      });
    }

    const newlyAvailableAliases = new Set<string>();
    for (const alias of this.availableAliases) {
      if (nextAvailableAliases.has(alias)) continue;
      aliasesToDeactivate.add(alias);
      this.unavailableAliases.add(alias);
      if (currentlyActiveTools.has(alias)) this.reactivateWhenAvailable.add(alias);
      else this.reactivateWhenAvailable.delete(alias);
    }
    for (const alias of nextAvailableAliases) {
      if (!this.availableAliases.has(alias)) newlyAvailableAliases.add(alias);
    }

    // Availability policy is updated before activation checks so a returning alias is no longer
    // rejected solely because the previous stale snapshot marked it unavailable.
    for (const alias of newlyAvailableAliases) this.reportToolAvailability(alias, true);
    const aliasesToActivate = new Set<string>();
    for (const alias of activationCandidates) {
      if (canActivateTool(alias)) aliasesToActivate.add(alias);
    }
    this.reconcileActiveTools(aliasesToActivate, aliasesToDeactivate);

    for (const alias of this.availableAliases) {
      if (!nextAvailableAliases.has(alias)) this.reportToolAvailability(alias, false);
    }
    for (const alias of newlyAvailableAliases) {
      this.unavailableAliases.delete(alias);
      this.reactivateWhenAvailable.delete(alias);
    }
    this.availableAliases.clear();
    for (const alias of nextAvailableAliases) this.availableAliases.add(alias);

    this.snapshot = {
      enabledServers: servers.filter((server) => server.enabled).length,
      connectedServers: servers.filter((server) => server.state === "connected").length,
      servers,
    };
    if (this.ctx) this.notifySnapshot(this.snapshot, this.ctx);
  }

  private reconcileActiveTools(activate: ReadonlySet<string>, deactivate: ReadonlySet<string>): void {
    if (activate.size === 0 && deactivate.size === 0) return;
    const current = this.options.pi.getActiveTools();
    const next = current.filter((name) => !deactivate.has(name));
    const present = new Set(next);
    for (const alias of activate) {
      if (present.has(alias)) continue;
      next.push(alias);
      present.add(alias);
    }
    if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
      this.options.pi.setActiveTools(next);
    }
  }

  private reportToolAvailability(aliasName: string, available: boolean): void {
    try {
      this.options.onToolAvailabilityChange?.(aliasName, available);
    } catch {
      // Availability bookkeeping is best-effort; active-tools reconciliation remains authoritative.
    }
  }

  private notifySnapshot(snapshot: McpSnapshot, ctx: ExtensionContext): void {
    try {
      this.options.onSnapshotChange?.(snapshot, ctx);
    } catch {
      // Session contexts can become stale during replacement; status updates are best-effort.
    }
  }
}
