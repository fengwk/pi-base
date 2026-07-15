import { createSdkMcpClient } from "./client.js";
import type {
  McpClientFactory,
  McpConfig,
  McpProtocolClient,
  McpServerConfig,
  McpServerState,
  McpTool,
  McpToolCallResult,
} from "./types.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
const DEFAULT_CALL_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;

interface HubToolRuntime {
  tool: McpTool;
  stale: boolean;
}

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
  tools: Map<string, HubToolRuntime>;
}

export interface McpHubOptions {
  clientFactory?: McpClientFactory;
  heartbeatIntervalMs?: number;
  retryDelaysMs?: readonly number[];
  callWaitTimeoutMs?: number;
}

export interface McpHubToolSnapshot {
  tool: McpTool;
  stale: boolean;
}

export interface McpHubServerSnapshot {
  key: string;
  config: McpServerConfig;
  state: McpServerState;
  lastError?: string;
  nextRetryInMs?: number;
  tools: McpHubToolSnapshot[];
}

export interface McpHubSnapshot {
  servers: McpHubServerSnapshot[];
}

export type McpHubSnapshotListener = (snapshot: McpHubSnapshot) => void;

export class McpHub {
  private clientFactory: McpClientFactory = createSdkMcpClient;
  private heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  private retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS;
  private callWaitTimeoutMs = DEFAULT_CALL_WAIT_TIMEOUT_MS;
  private defaultStartupTimeoutMs = DEFAULT_MCP_STARTUP_TIMEOUT_MS;
  private defaultCallTimeoutMs = DEFAULT_MCP_CALL_TIMEOUT_MS;
  private runtimes = new Map<string, ServerRuntime>();
  private listeners = new Set<McpHubSnapshotListener>();
  private attachments = new Set<symbol>();
  private configurePromise: Promise<void> | undefined;
  private configFingerprint: string | undefined;
  private configGeneration = 0;
  private runId = 0;
  private shutdownWhenUnused = false;

  attach(listener: McpHubSnapshotListener): { release: () => Promise<void> } {
    const token = Symbol("mcp-session");
    this.attachments.add(token);
    this.listeners.add(listener);
    this.shutdownWhenUnused = false;
    this.notifyListener(listener, this.getSnapshot());
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.listeners.delete(listener);
        this.attachments.delete(token);
        if (this.shutdownWhenUnused && this.attachments.size === 0) {
          await this.shutdown();
        }
      },
    };
  }

  requestShutdownWhenUnused(): void {
    this.shutdownWhenUnused = true;
    if (this.attachments.size === 0) void this.shutdown();
  }

  configure(config: McpConfig | undefined, options: McpHubOptions = {}): Promise<void> {
    const fingerprint = fingerprintConfig(config);
    if (this.configFingerprint === fingerprint) return this.configurePromise ?? Promise.resolve();

    const generation = ++this.configGeneration;
    this.configFingerprint = fingerprint;
    const promise = this.replaceConfiguration(config, options, generation)
      .finally(() => {
        if (this.configGeneration === generation) this.configurePromise = undefined;
      });
    this.configurePromise = promise;
    return promise;
  }

  async shutdown(): Promise<void> {
    // Invalidate queued/in-flight configuration work before disconnecting so an
    // earlier startup cannot resurrect its server after quit.
    const generation = ++this.configGeneration;
    this.configFingerprint = undefined;
    this.configurePromise = undefined;
    await this.stopRuntimes();
    // A new session may configure the shared hub while an old disconnect is still settling.
    // In that case the newer generation owns the defaults and must not be overwritten here.
    if (this.configGeneration !== generation) return;
    this.defaultStartupTimeoutMs = DEFAULT_MCP_STARTUP_TIMEOUT_MS;
    this.defaultCallTimeoutMs = DEFAULT_MCP_CALL_TIMEOUT_MS;
    this.shutdownWhenUnused = false;
  }

  getSnapshot(): McpHubSnapshot {
    return {
      servers: Array.from(this.runtimes.values()).map((runtime) => ({
        key: runtime.key,
        config: runtime.config,
        state: runtime.state,
        lastError: runtime.lastError,
        nextRetryInMs: runtime.nextRetryAt === undefined ? undefined : Math.max(0, runtime.nextRetryAt - Date.now()),
        tools: Array.from(runtime.tools.values())
          .sort((left, right) => left.tool.name.localeCompare(right.tool.name))
          .map(({ tool, stale }) => ({ tool, stale })),
      })),
    };
  }

  async call(
    serverKey: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
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
      return await client.callTool(toolName, args, {
        signal,
        timeout: runtime.config.callTimeoutMs ?? this.defaultCallTimeoutMs,
      });
    } catch (error) {
      if (isRecoverableConnectionError(error)) {
        void this.requestReconnect(runtime, error, runId);
      }
      throw error;
    }
  }

  private async replaceConfiguration(
    config: McpConfig | undefined,
    options: McpHubOptions,
    generation: number,
  ): Promise<void> {
    await this.stopRuntimes();
    if (this.configGeneration !== generation) return;

    this.applyOptions(options);
    this.defaultStartupTimeoutMs = config?.startupTimeoutMs ?? DEFAULT_MCP_STARTUP_TIMEOUT_MS;
    this.defaultCallTimeoutMs = config?.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS;
    this.shutdownWhenUnused = false;
    this.runtimes = new Map(Object.entries(config?.servers ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, serverConfig]) => [key, createServerRuntime(key, serverConfig)]));

    const runId = ++this.runId;
    this.publishSnapshot();
    const initialConnections: Promise<void>[] = [];
    for (const runtime of this.runtimes.values()) {
      if (!isServerEnabled(runtime.config)) continue;
      initialConnections.push(this.ensureConnected(runtime.key, runId));
    }
    await Promise.all(initialConnections);
  }

  private applyOptions(options: McpHubOptions): void {
    this.clientFactory = options.clientFactory ?? createSdkMcpClient;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.retryDelaysMs = options.retryDelaysMs?.length ? [...options.retryDelaysMs] : DEFAULT_RETRY_DELAYS_MS;
    this.callWaitTimeoutMs = options.callWaitTimeoutMs ?? DEFAULT_CALL_WAIT_TIMEOUT_MS;
  }

  private async stopRuntimes(): Promise<void> {
    ++this.runId;
    const disconnects: Promise<void>[] = [];
    for (const runtime of this.runtimes.values()) {
      this.clearRetry(runtime);
      this.clearHeartbeat(runtime);
      disconnects.push(...collectDisconnects(runtime));
    }
    this.runtimes.clear();
    await Promise.allSettled(disconnects);
    this.publishSnapshot();
  }

  private async ensureConnected(serverKey: string, runId: number): Promise<void> {
    const runtime = this.runtimes.get(serverKey);
    if (!runtime || !isServerEnabled(runtime.config) || this.runId !== runId) return;
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

    let client: McpProtocolClient | undefined;
    try {
      client = this.clientFactory(runtime.key, runtime.config);
      runtime.pendingClient = client;
      const startupTimeoutMs = runtime.config.startupTimeoutMs ?? this.defaultStartupTimeoutMs;
      const startupDeadline = Date.now() + startupTimeoutMs;
      await client.connect(startupTimeoutMs);
      if (this.runId !== runId) return;

      runtime.pendingClient = undefined;
      runtime.client = client;
      const remainingStartupMs = startupDeadline - Date.now();
      if (remainingStartupMs <= 0) {
        throw new Error(`Connection timeout (>${Math.ceil(startupTimeoutMs / 1000)}s)`);
      }
      const tools = await client.listTools({ timeout: remainingStartupMs });
      if (this.runId !== runId) return;

      runtime.state = "connected";
      runtime.hasConnected = true;
      runtime.attempt = 0;
      runtime.lastError = undefined;
      runtime.nextRetryAt = undefined;
      this.refreshTools(runtime, tools);
      this.scheduleHeartbeat(runtime, runId);
    } catch (error) {
      if (client && runtime.pendingClient === client) runtime.pendingClient = undefined;
      if (this.runId !== runId) return;
      if (client) await client.disconnect().catch(() => undefined);

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
    const seen = new Set<string>();
    for (const tool of tools) {
      seen.add(tool.name);
      runtime.tools.set(tool.name, { tool, stale: false });
    }
    for (const [name, current] of runtime.tools) {
      if (!seen.has(name)) runtime.tools.set(name, { ...current, stale: true });
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
    const delayMs = this.retryDelaysMs[Math.min(runtime.attempt - 1, this.retryDelaysMs.length - 1)]
      ?? this.retryDelaysMs[this.retryDelaysMs.length - 1]
      ?? 60_000;
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
        ? Math.max(this.callWaitTimeoutMs, runtime.config.startupTimeoutMs ?? this.defaultStartupTimeoutMs)
        : this.callWaitTimeoutMs;
      await waitForCompletion(connectPromise, waitTimeoutMs, signal);
    }

    if (signal?.aborted) throw new Error("Tool call cancelled.");
    if (this.runId !== runId) throw new Error(`MCP server ${runtime.key} is not available.`);
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

  private clearRetry(runtime: ServerRuntime): void {
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = undefined;
  }

  private clearHeartbeat(runtime: ServerRuntime): void {
    if (runtime.heartbeatTimer) clearTimeout(runtime.heartbeatTimer);
    runtime.heartbeatTimer = undefined;
  }

  private publishSnapshot(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) this.notifyListener(listener, snapshot);
  }

  private notifyListener(listener: McpHubSnapshotListener, snapshot: McpHubSnapshot): void {
    try {
      listener(snapshot);
    } catch {
      // Session bindings can become stale during reload; one listener must not break the shared hub.
    }
  }
}

export function createMcpHub(): McpHub {
  return new McpHub();
}

const PROCESS_MCP_HUB_KEY = Symbol.for("pi-base.process-mcp-hub");
const processGlobals = globalThis as typeof globalThis & { [PROCESS_MCP_HUB_KEY]?: McpHub };
export const processMcpHub = processGlobals[PROCESS_MCP_HUB_KEY] ??= createMcpHub();

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
  return error instanceof Error ? error.message : String(error);
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
  for (const item of collectErrorChain(error)) {
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

function fingerprintConfig(config: McpConfig | undefined): string {
  return JSON.stringify(config ?? {});
}
