import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import type { McpClientFactory, McpProtocolClient, McpServerConfig, McpTool, McpToolCallResult } from "./types.js";

type ClientTransport =
  | StdioClientTransport
  | SSEClientTransport
  | StreamableHTTPClientTransport
  | WebSocketClientTransport;

export const createSdkMcpClient: McpClientFactory = (_serverKey, config) => new SdkMcpClient(config);
const ENV_REFERENCE_PATTERN = /^\$(?:\{(?<braced>[A-Za-z_][A-Za-z0-9_]*)\}|(?<bare>[A-Za-z_][A-Za-z0-9_]*))$/;

class SdkMcpClient implements McpProtocolClient {
  private client: Client | undefined;
  private transport: ClientTransport | undefined;
  private connected = false;

  constructor(private readonly config: McpServerConfig) {}

  async connect(timeoutMs: number): Promise<void> {
    if (this.connected) return;

    const client = new Client({ name: "pi-base-mcp", version: "0.1.0" });
    const transport = this.createTransport();
    try {
      await withTimeout(client.connect(transport), timeoutMs, `Connection timeout (>${Math.ceil(timeoutMs / 1000)}s)`);
      this.client = client;
      this.transport = transport;
      this.connected = true;
    } catch (error) {
      await closeClient(client);
      this.client = undefined;
      this.transport = undefined;
      this.connected = false;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.connected = false;
    if (!client) return;
    await closeClient(client);
  }

  async listTools(): Promise<McpTool[]> {
    const response = await this.requireClient().listTools();
    return Array.isArray(response.tools) ? (response.tools as McpTool[]) : [];
  }

  async callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<McpToolCallResult> {
    return this.requireClient().callTool({ name, arguments: args }, undefined, options) as Promise<McpToolCallResult>;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private requireClient(): Client {
    if (!this.client || !this.connected) throw new Error("MCP client is not connected.");
    return this.client;
  }

  private createTransport(): ClientTransport {
    if (this.config.type === "local") {
      const [command, ...args] = this.config.command;
      if (!command) throw new Error("Local MCP command must not be empty.");
      return new StdioClientTransport({
        command,
        args,
        env: buildLocalEnv(this.config.env),
        cwd: this.config.cwd,
        stderr: "ignore",
      });
    }

    const url = new URL(this.config.url);
    const headers = resolveConfigStringMap(this.config.headers, "mcp remote headers");
    switch (this.config.transport) {
      case "streamable-http":
        return new StreamableHTTPClientTransport(url, {
          requestInit: headers ? { headers } : undefined,
          reconnectionOptions: {
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
            maxRetries: 0,
          },
        });
      case "sse":
        return new SSEClientTransport(url, {
          requestInit: headers ? { headers } : undefined,
          eventSourceInit: headers ? { fetch: buildEventSourceFetch(headers) } : undefined,
        });
      case "websocket":
        if (headers && Object.keys(headers).length > 0) {
          throw new Error("websocket transport does not support custom headers in this SDK.");
        }
        return new WebSocketClientTransport(url);
      default: {
        const exhaustivenessCheck: never = this.config.transport;
        throw new Error(`Unsupported MCP transport: ${String(exhaustivenessCheck)}`);
      }
    }
  }
}

export function resolveConfigString(value: string, path: string): string {
  const match = value.match(ENV_REFERENCE_PATTERN);
  if (!match) return value;
  const name = match.groups?.braced ?? match.groups?.bare;
  if (!name) return value;
  const resolved = process.env[name];
  if (resolved === undefined) {
    throw new Error(`${path} references missing environment variable ${name}.`);
  }
  return resolved;
}

export function resolveConfigStringMap(values: Record<string, string> | undefined, path: string): Record<string, string> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, resolveConfigString(value, `${path}.${key}`)]));
}

function buildLocalEnv(env: Record<string, string> | undefined): Record<string, string> {
  const merged: Record<string, string> = {};
  const resolvedEnv = resolveConfigStringMap(env, "mcp local env") ?? {};
  for (const [key, value] of Object.entries({ ...process.env, ...resolvedEnv })) {
    if (value !== undefined) merged[key] = String(value);
  }
  return merged;
}
function buildEventSourceFetch(headers: Record<string, string>) {
  return async (input: string | URL, init: RequestInit) => {
    const mergedHeaders = new Headers(init.headers ?? undefined);
    for (const [key, value] of Object.entries(headers)) {
      mergedHeaders.set(key, value);
    }
    return fetch(input, { ...init, headers: mergedHeaders });
  };
}

async function closeClient(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // Ignore close errors during reconnect and shutdown.
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
