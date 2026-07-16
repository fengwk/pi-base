export type McpRemoteTransport = "websocket" | "sse" | "streamable-http";

export interface LocalMcpServerConfig {
  type: "local";
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  toolPrefix?: string;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
}

export interface RemoteMcpServerConfig {
  type: "remote";
  transport: McpRemoteTransport;
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  toolPrefix?: string;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
}

export type McpServerConfig = LocalMcpServerConfig | RemoteMcpServerConfig;

export interface McpConfig {
  servers?: Record<string, McpServerConfig>;
  /** Default server startup timeout. Server-level `startupTimeoutMs` takes precedence. */
  startupTimeoutMs?: number;
  /**
   * Default per-tool call timeout applied when a server entry does not set its own
   * `callTimeoutMs`. Defaults to 60000 ms (matches the MCP SDK's DEFAULT_REQUEST_TIMEOUT_MSEC).
   */
  callTimeoutMs?: number;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResultContent {
  type: string;
  text?: string;
  data?: unknown;
}

export interface McpToolCallResult {
  content?: McpToolResultContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpProtocolClient {
  connect(timeoutMs: number): Promise<void>;
  disconnect(): Promise<void>;
  listTools(options?: { signal?: AbortSignal; timeout?: number }): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeout?: number }): Promise<McpToolCallResult>;
  isConnected(): boolean;
}

export type McpServerState = "disabled" | "idle" | "starting" | "connected" | "reconnecting" | "failed";
export type McpToolState = "registered" | "conflict" | "stale";

export interface McpToolSnapshot {
  remoteName: string;
  aliasName: string;
  description?: string;
  state: McpToolState;
  reason?: string;
}

export interface McpServerSnapshot {
  key: string;
  enabled: boolean;
  state: McpServerState;
  type: "local" | "remote";
  transport?: McpRemoteTransport;
  prefix: string;
  lastError?: string;
  nextRetryInMs?: number;
  tools: McpToolSnapshot[];
}

export interface McpSnapshot {
  enabledServers: number;
  connectedServers: number;
  servers: McpServerSnapshot[];
}

export type McpClientFactory = (serverKey: string, config: McpServerConfig) => McpProtocolClient;
