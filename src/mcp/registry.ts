import { createMcpHub, type McpHub } from "./hub.js";

interface McpHubRegistryEntry {
  rootSessionId: string;
  hub: McpHub;
  leases: Set<symbol>;
  terminal: boolean;
  shutdownPromise?: Promise<void>;
}

export interface McpHubLease {
  hub: McpHub;
  markTerminal(): void;
  release(): Promise<void>;
  abandon(): Promise<void>;
}

export class McpHubRegistry {
  private readonly entries = new Map<string, McpHubRegistryEntry>();

  constructor(private readonly createHub: () => McpHub = createMcpHub) {}

  acquire(rootSessionId: string): McpHubLease {
    let entry = this.entries.get(rootSessionId);
    const createdEntry = !entry || entry.terminal;
    if (!entry || entry.terminal) {
      entry = {
        rootSessionId,
        hub: this.createHub(),
        leases: new Set(),
        terminal: false,
      };
      this.entries.set(rootSessionId, entry);
    }

    const token = Symbol("mcp-session-lease");
    entry.leases.add(token);
    let released = false;
    const release = async (abandon: boolean) => {
      if (released) return;
      released = true;
      entry.leases.delete(token);
      if (abandon && createdEntry && entry.leases.size === 0 && this.entries.get(rootSessionId) === entry) {
        entry.terminal = true;
      }
      await this.shutdownIfUnused(entry);
    };
    return {
      hub: entry.hub,
      markTerminal: () => {
        if (!released) entry.terminal = true;
      },
      release: () => release(false),
      abandon: () => release(true),
    };
  }

  private shutdownIfUnused(entry: McpHubRegistryEntry): Promise<void> {
    if (!entry.terminal || entry.leases.size > 0) return Promise.resolve();
    if (!entry.shutdownPromise) {
      entry.shutdownPromise = entry.hub.shutdown()
        .finally(() => {
          // A new session may acquire the same root id while this older terminal
          // entry is still shutting down. Never delete that replacement entry.
          if (this.entries.get(entry.rootSessionId) === entry) {
            this.entries.delete(entry.rootSessionId);
          }
        });
    }
    return entry.shutdownPromise;
  }
}

export function createMcpHubRegistry(createHub?: () => McpHub): McpHubRegistry {
  return new McpHubRegistry(createHub);
}

const PROCESS_MCP_HUB_REGISTRY_KEY = Symbol.for("pi-base.process-mcp-hub-registry");
const processGlobals = globalThis as typeof globalThis & {
  [PROCESS_MCP_HUB_REGISTRY_KEY]?: McpHubRegistry;
};
export const processMcpHubRegistry = processGlobals[PROCESS_MCP_HUB_REGISTRY_KEY] ??= createMcpHubRegistry();
