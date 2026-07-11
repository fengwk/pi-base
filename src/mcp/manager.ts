import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoadedPiBaseSettings } from "../config.js";
import type { CollapsedResultLinesResolver, CollapsedResultMaxCharsResolver } from "../render.js";
import { buildMcpToolName, createMcpToolDefinition, resolveMcpToolPrefix } from "./adapter.js";
import { createSdkMcpClient } from "./client.js";
import { withPiBaseErrorMarker } from "../tool-error-marker.js";
import type { McpClientFactory, McpProtocolClient, McpServerConfig, McpServerSnapshot, McpServerState, McpSnapshot, McpTool, McpToolSnapshot } from "./types.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
const DEFAULT_CALL_WAIT_TIMEOUT_MS = 5_000;

interface ServerRuntime {
  key: string;
  config: McpServerConfig;
  state: McpServerState;
  hasConnected: boolean;
  attempt: number;
  lastError?: string;
  nextRetryAt?: number;
  client?: McpProtocolClient;
  pendingClient?: McpProtocolClient;
  connectPromise?: Promise<void>;
  retryTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
  tools: Map<string, McpToolSnapshot>;
}

export interface McpManagerOptions {
  loadSettings: (cwd: string) => LoadedPiBaseSettings;
  clientFactory?: McpClientFactory;
  heartbeatIntervalMs?: number;
  retryDelaysMs?: readonly number[];
  callWaitTimeoutMs?: number;
  getCollapsedResultLines?: CollapsedResultLinesResolver;
  getCollapsedResultMaxChars?: CollapsedResultMaxCharsResolver;
  /** Whether a newly available MCP alias is allowed to become active for the current agent. */
  canActivateTool?: (toolName: string) => boolean;
  /** Reports whether an MCP alias currently represents a live server-advertised tool. */
  onToolAvailabilityChange?: (toolName: string, available: boolean) => void;
  onSnapshotChange?: (snapshot: McpSnapshot, ctx: ExtensionContext) => void;
}

export class McpManager {
  private readonly clientFactory: McpClientFactory;
  private readonly heartbeatIntervalMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly callWaitTimeoutMs: number;
  private ctx: ExtensionContext | undefined;
  private pi: Pick<ExtensionAPI, "registerTool" | "getAllTools" | "getActiveTools" | "setActiveTools"> | undefined;
  private runtimes = new Map<string, ServerRuntime>();
  private toolOwners = new Map<string, string>();
  private runId = 0;

  constructor(private readonly options: McpManagerOptions) {
    this.clientFactory = options.clientFactory ?? createSdkMcpClient;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.retryDelaysMs = options.retryDelaysMs?.length ? [...options.retryDelaysMs] : DEFAULT_RETRY_DELAYS_MS;
    this.callWaitTimeoutMs = options.callWaitTimeoutMs ?? DEFAULT_CALL_WAIT_TIMEOUT_MS;
  }

  async start(
    ctx: ExtensionContext,
    pi: Pick<ExtensionAPI, "registerTool" | "getAllTools" | "getActiveTools" | "setActiveTools">,
  ): Promise<void> {
    await this.shutdown();
    const runId = ++this.runId;
    this.ctx = ctx;
    this.pi = pi;

    const servers = this.options.loadSettings(ctx.cwd).settings.mcp?.servers ?? {};
    this.runtimes = new Map(Object.entries(servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, config]) => [key, createServerRuntime(key, config)]));

    this.publishSnapshot();
    for (const runtime of this.runtimes.values()) {
      if (!isServerEnabled(runtime.config)) continue;
      void this.ensureConnected(runtime.key, runId);
    }
  }

  async shutdown(): Promise<void> {
    const ctx = this.ctx;
    ++this.runId;
    const disconnects: Promise<void>[] = [];
    const aliasesToDeactivate = new Set<string>();
    for (const runtime of this.runtimes.values()) {
      this.clearRetry(runtime);
      this.clearHeartbeat(runtime);
      for (const snapshot of runtime.tools.values()) {
        if (snapshot.state !== "conflict") {
          aliasesToDeactivate.add(snapshot.aliasName);
          this.reportToolAvailability(snapshot.aliasName, false);
        }
      }
      disconnects.push(...collectDisconnects(runtime));
    }
    // Retire aliases from the active-tools set before dropping runtimes so a torn-down
    // server never leaves the model a tool it can no longer call.
    this.reconcileActiveTools(new Set(), aliasesToDeactivate);

    this.ctx = undefined;
    this.pi = undefined;
    this.runtimes.clear();
    await Promise.allSettled(disconnects);

    if (ctx) {
      this.notifySnapshot({ enabledServers: 0, connectedServers: 0, servers: [] }, ctx);
    }
  }

  getSnapshot(): McpSnapshot {
    const servers = Array.from(this.runtimes.values()).map((runtime) => this.toServerSnapshot(runtime));
    const enabledServers = servers.filter((server) => server.enabled).length;
    const connectedServers = servers.filter((server) => server.state === "connected").length;
    return { enabledServers, connectedServers, servers };
  }

  async call(
    serverKey: string,
    toolName: string,
    args: Record<string, unknown>,
    _ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw new Error("Tool call cancelled.");

    const runtime = this.runtimes.get(serverKey);
    if (!runtime || !isServerEnabled(runtime.config)) {
      throw new Error(`MCP server ${serverKey} is not enabled.`);
    }

    const runId = this.runId;
    await this.waitForConnected(runtime, runId, signal);
    if (signal?.aborted) throw new Error("Tool call cancelled.");

    const client = runtime.client;
    if (!client || !client.isConnected()) {
      throw new Error(buildNotConnectedMessage(runtime));
    }

    try {
      return await client.callTool(toolName, args, { signal });
    } catch (error) {
      if (isRecoverableConnectionError(error)) {
        void this.requestReconnect(runtime, error, runId);
      }
      throw error;
    }
  }

  private async ensureConnected(serverKey: string, runId: number): Promise<void> {
    const runtime = this.runtimes.get(serverKey);
    if (!runtime || !isServerEnabled(runtime.config) || !this.pi || this.runId !== runId) return;
    if (runtime.connectPromise) return runtime.connectPromise;

    this.clearRetry(runtime);
    runtime.nextRetryAt = undefined;
    runtime.state = runtime.hasConnected ? "reconnecting" : "starting";
    this.publishSnapshot();

    const promise = this.connectRuntime(runtime, runId);
    runtime.connectPromise = promise;
    try {
      await promise;
    } finally {
      if (runtime.connectPromise === promise) runtime.connectPromise = undefined;
    }
  }

  private async connectRuntime(runtime: ServerRuntime, runId: number): Promise<void> {
    await this.disconnectClient(runtime);
    if (this.runId !== runId) return;

    const client = this.clientFactory(runtime.key, runtime.config);
    runtime.pendingClient = client;

    try {
      await client.connect(runtime.config.startupTimeoutMs ?? 60_000);
      if (this.runId !== runId) {
        await client.disconnect().catch(() => undefined);
        return;
      }

      runtime.pendingClient = undefined;
      runtime.client = client;
      const tools = await client.listTools();
      if (this.runId !== runId) {
        await client.disconnect().catch(() => undefined);
        return;
      }

      runtime.state = "connected";
      runtime.hasConnected = true;
      runtime.attempt = 0;
      runtime.lastError = undefined;
      runtime.nextRetryAt = undefined;
      this.refreshTools(runtime, tools);
      this.scheduleHeartbeat(runtime, runId);
    } catch (error) {
      if (runtime.pendingClient === client) runtime.pendingClient = undefined;
      await client.disconnect().catch(() => undefined);
      if (this.runId !== runId) return;

      runtime.client = undefined;
      runtime.lastError = getErrorMessage(error);
      runtime.attempt += 1;
      runtime.state = "failed";
      this.scheduleRetry(runtime, runId);
    } finally {
      this.publishSnapshot();
    }
  }

  private refreshTools(runtime: ServerRuntime, tools: McpTool[]): void {
    const pi = this.pi;
    if (!pi) return;

    const canActivateTool = this.options.canActivateTool ?? (() => true);
    const seenRemoteNames = new Set<string>();
    const existingToolNames = new Set(pi.getAllTools().map((tool: { name: string }) => tool.name));
    const aliasesToActivate = new Set<string>();
    const aliasesToDeactivate = new Set<string>();

    for (const tool of [...tools].sort((left, right) => left.name.localeCompare(right.name))) {
      seenRemoteNames.add(tool.name);
      const aliasName = buildMcpToolName(runtime.key, tool.name, runtime.config.toolPrefix);
      const owner = this.toolOwners.get(aliasName);
      const registeredByThisServer = owner === runtime.key;
      const ownedByInactiveServer = owner !== undefined && owner !== runtime.key && !this.runtimes.has(owner);
      const conflictsWithExistingTool = !registeredByThisServer && !ownedByInactiveServer && existingToolNames.has(aliasName);

      if (conflictsWithExistingTool) {
        runtime.tools.set(tool.name, {
          remoteName: tool.name,
          aliasName,
          description: tool.description,
          state: "conflict",
          reason: owner && owner !== runtime.key ? `already registered by ${owner}` : "tool name already exists",
        });
        continue;
      }

      pi.registerTool(withPiBaseErrorMarker(createMcpToolDefinition({
        serverKey: runtime.key,
        serverConfig: runtime.config,
        tool,
        callTool: (serverKey, toolName, args, ctx, signal) => this.call(serverKey, toolName, args, ctx, signal),
        getCollapsedResultLines: this.options.getCollapsedResultLines,
        getCollapsedResultMaxChars: this.options.getCollapsedResultMaxChars,
      })));

      if (!registeredByThisServer) {
        this.toolOwners.set(aliasName, runtime.key);
        existingToolNames.add(aliasName);
      }
      this.reportToolAvailability(aliasName, true);
      if (canActivateTool(aliasName)) aliasesToActivate.add(aliasName);

      runtime.tools.set(tool.name, {
        remoteName: tool.name,
        aliasName,
        description: tool.description,
        state: "registered",
      });
    }

    for (const [remoteName, snapshot] of runtime.tools.entries()) {
      if (seenRemoteNames.has(remoteName) || snapshot.state === "conflict") continue;
      runtime.tools.set(remoteName, { ...snapshot, state: "stale" });
      // A tool the server no longer advertises must stop being an active tool, so the
      // model cannot pick an alias that would only fail once it reaches execution.
      this.reportToolAvailability(snapshot.aliasName, false);
      aliasesToDeactivate.add(snapshot.aliasName);
    }

    this.reconcileActiveTools(aliasesToActivate, aliasesToDeactivate);
  }

  // The host cannot unregister a tool definition, so alias lifecycle is enforced by
  // adding/removing alias names from the active-tools set that the model can pick from.
  private reconcileActiveTools(activate: ReadonlySet<string>, deactivate: ReadonlySet<string>): void {
    const pi = this.pi;
    if (!pi) return;
    if (activate.size === 0 && deactivate.size === 0) return;

    const current = pi.getActiveTools();
    const next = current.filter((name) => !deactivate.has(name));
    const present = new Set(next);
    for (const alias of activate) {
      if (present.has(alias)) continue;
      next.push(alias);
      present.add(alias);
    }

    if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
      pi.setActiveTools(next);
    }
  }

  private reportToolAvailability(aliasName: string, available: boolean): void {
    try {
      this.options.onToolAvailabilityChange?.(aliasName, available);
    } catch {
      // Availability bookkeeping is best-effort; active-tools reconciliation remains authoritative.
    }
  }

  private scheduleHeartbeat(runtime: ServerRuntime, runId: number): void {
    this.clearHeartbeat(runtime);
    runtime.heartbeatTimer = setTimeout(async () => {
      if (this.runId !== runId || runtime.state !== "connected" || !runtime.client) return;
      try {
        const tools = await runtime.client.listTools();
        if (this.runId !== runId) return;
        this.refreshTools(runtime, tools);
        this.publishSnapshot();
        this.scheduleHeartbeat(runtime, runId);
      } catch (error) {
        await this.handleConnectionLoss(runtime, error, runId);
      }
    }, this.heartbeatIntervalMs);
  }

  private scheduleRetry(runtime: ServerRuntime, runId: number): void {
    this.clearRetry(runtime);
    const delayMs = this.retryDelaysMs[Math.min(runtime.attempt - 1, this.retryDelaysMs.length - 1)] ?? this.retryDelaysMs[this.retryDelaysMs.length - 1] ?? 60_000;
    runtime.nextRetryAt = Date.now() + delayMs;
    runtime.retryTimer = setTimeout(() => {
      if (this.runId !== runId) return;
      void this.ensureConnected(runtime.key, runId);
    }, delayMs);
  }

  private async handleConnectionLoss(runtime: ServerRuntime, error: unknown, runId: number): Promise<void> {
    runtime.lastError = getErrorMessage(error);
    runtime.state = "reconnecting";
    runtime.attempt = 0;
    this.publishSnapshot();
    await this.disconnectClient(runtime);
    if (this.runId !== runId) return;
    void this.ensureConnected(runtime.key, runId);
  }

  private async requestReconnect(runtime: ServerRuntime, error: unknown, runId: number): Promise<void> {
    if (runtime.connectPromise) return;
    await this.handleConnectionLoss(runtime, error, runId);
  }

  private async waitForConnected(runtime: ServerRuntime, runId: number, signal?: AbortSignal): Promise<void> {
    if (runtime.state === "connected" && runtime.client?.isConnected()) return;

    const connectPromise = runtime.connectPromise ?? this.ensureConnected(runtime.key, runId);
    if (connectPromise) {
      const waitTimeoutMs = runtime.state === "starting"
        ? Math.max(this.callWaitTimeoutMs, runtime.config.startupTimeoutMs ?? 60_000)
        : this.callWaitTimeoutMs;
      await waitForCompletion(connectPromise, waitTimeoutMs, signal);
    }

    if (signal?.aborted) {
      throw new Error("Tool call cancelled.");
    }
    if (this.runId !== runId) {
      throw new Error(`MCP server ${runtime.key} is not available.`);
    }
    if (runtime.state === "connected" && runtime.client?.isConnected()) return;
    throw new Error(buildNotConnectedMessage(runtime));
  }

  private async disconnectClient(runtime: ServerRuntime): Promise<void> {
    this.clearHeartbeat(runtime);
    this.clearRetry(runtime);
    runtime.nextRetryAt = undefined;

    const clients = new Set<McpProtocolClient>();
    if (runtime.client) clients.add(runtime.client);
    if (runtime.pendingClient) clients.add(runtime.pendingClient);
    runtime.client = undefined;
    runtime.pendingClient = undefined;

    await Promise.allSettled(Array.from(clients, async (client) => {
      await client.disconnect();
    }));
  }

  private toServerSnapshot(runtime: ServerRuntime): McpServerSnapshot {
    const tools = Array.from(runtime.tools.values())
      .sort((left, right) => left.aliasName.localeCompare(right.aliasName) || left.remoteName.localeCompare(right.remoteName));
    return {
      key: runtime.key,
      enabled: isServerEnabled(runtime.config),
      state: runtime.state,
      type: runtime.config.type,
      transport: runtime.config.type === "remote" ? runtime.config.transport : undefined,
      prefix: resolveMcpToolPrefix(runtime.key, runtime.config.toolPrefix),
      lastError: runtime.lastError,
      nextRetryInMs: runtime.nextRetryAt === undefined ? undefined : Math.max(0, runtime.nextRetryAt - Date.now()),
      tools,
    };
  }

  private clearRetry(runtime: ServerRuntime): void {
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = undefined;
  }

  private clearHeartbeat(runtime: ServerRuntime): void {
    if (runtime.heartbeatTimer) clearTimeout(runtime.heartbeatTimer);
    runtime.heartbeatTimer = undefined;
  }

  private publishSnapshot(): void {
    if (!this.ctx) return;
    this.notifySnapshot(this.getSnapshot(), this.ctx);
  }

  private notifySnapshot(snapshot: McpSnapshot, ctx: ExtensionContext): void {
    try {
      this.options.onSnapshotChange?.(snapshot, ctx);
    } catch {
      // Extension contexts can become stale during session replacement; status updates are best-effort.
    }
  }
}

export function createMcpManager(options: McpManagerOptions): McpManager {
  return new McpManager(options);
}

function createServerRuntime(key: string, config: McpServerConfig): ServerRuntime {
  return {
    key,
    config,
    state: isServerEnabled(config) ? "idle" : "disabled",
    hasConnected: false,
    attempt: 0,
    tools: new Map(),
  };
}

function isServerEnabled(config: McpServerConfig): boolean {
  return config.enabled !== false;
}

function buildNotConnectedMessage(runtime: ServerRuntime): string {
  return runtime.lastError
    ? `MCP server ${runtime.key} is not connected: ${runtime.lastError}`
    : `MCP server ${runtime.key} is not connected.`;
}

function collectDisconnects(runtime: ServerRuntime): Promise<void>[] {
  const clients = new Set<McpProtocolClient>();
  if (runtime.client) clients.add(runtime.client);
  if (runtime.pendingClient) clients.add(runtime.pendingClient);
  runtime.client = undefined;
  runtime.pendingClient = undefined;
  return Array.from(clients, async (client) => {
    await client.disconnect();
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const RECOVERABLE_CONNECTION_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);
const RECOVERABLE_CONNECTION_ERROR_PATTERNS = [
  /\bnot connected\b/i,
  /\bconnection timeout\b/i,
  /\btransport closed\b/i,
  /\bsocket closed\b/i,
  /\bsocket hang up\b/i,
  /\bconnection reset\b/i,
  /\bbroken pipe\b/i,
  /\b(?:unexpected )?eof\b/i,
  /\b(?:transport|connection|socket) terminated\b/i,
  /\beconn(?:aborted|refused|reset)\b/i,
  /\bepipe\b/i,
];

function collectErrorChain(error: unknown): unknown[] {
  const queue = [error];
  const seen = new Set<unknown>();
  const output: unknown[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    output.push(current);
    if (current && typeof current === "object" && "cause" in current) {
      queue.push((current as { cause?: unknown }).cause);
    }
  }
  return output;
}

function isRecoverableConnectionError(error: unknown): boolean {
  const chain = collectErrorChain(error);
  for (const item of chain) {
    const code = item && typeof item === "object" && "code" in item ? (item as { code?: unknown }).code : undefined;
    if (typeof code === "string" && RECOVERABLE_CONNECTION_ERROR_CODES.has(code.toUpperCase())) return true;
    const message = getErrorMessage(item);
    if (RECOVERABLE_CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return true;
  }
  return false;
}

function waitForCompletion(promise: Promise<unknown>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", finish, { once: true });
    promise.then(finish, finish);
  });
}
