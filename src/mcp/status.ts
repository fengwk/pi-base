import type { McpServerSnapshot, McpSnapshot, McpToolSnapshot } from "./types.js";

export function renderMcpFooterStatus(snapshot: McpSnapshot): string | undefined {
  if (snapshot.enabledServers === 0) return undefined;
  const summary = `MCP: ${snapshot.connectedServers}/${snapshot.enabledServers} servers`;
  const suffix = buildFooterSuffix(snapshot.servers);
  return suffix ? `${summary} ${suffix}` : summary;
}

export function renderMcpStatusTree(snapshot: McpSnapshot): string {
  const lines = [renderMcpFooterStatus(snapshot) ?? "MCP: 0/0 servers"];
  if (snapshot.servers.length === 0) {
    lines.push("", "(no enabled servers)");
    return lines.join("\n");
  }

  lines.push("");
  snapshot.servers.forEach((server, index) => {
    const isLastServer = index === snapshot.servers.length - 1;
    const branch = isLastServer ? "\\-" : "+-";
    lines.push(`${branch} ${renderServerLine(server)}`);

    if (server.tools.length === 0) {
      lines.push(`${isLastServer ? "   " : "|  "}\\- (no tools discovered)`);
      return;
    }

    server.tools.forEach((tool, toolIndex) => {
      const toolIsLast = toolIndex === server.tools.length - 1;
      const prefix = isLastServer ? "   " : "|  ";
      const toolBranch = toolIsLast ? "\\-" : "+-";
      lines.push(`${prefix}${toolBranch} ${renderToolLine(tool)}`);
    });
  });

  return lines.join("\n");
}

function renderServerLine(server: McpServerSnapshot): string {
  const typeLabel = server.type === "local" ? "local" : server.transport;
  const parts = [`[${server.state}]`, `type=${typeLabel}`, `prefix=${JSON.stringify(server.prefix)}`];
  if (server.nextRetryInMs !== undefined) parts.push(`retry_in=${formatDuration(server.nextRetryInMs)}`);
  if (server.lastError) parts.push(`error=${JSON.stringify(server.lastError)}`);
  return `${server.key} ${parts.join(" ")}`;
}

function renderToolLine(tool: McpToolSnapshot): string {
  const aliasText = tool.aliasName === tool.remoteName
    ? tool.aliasName
    : `${tool.aliasName} (remote: ${tool.remoteName})`;
  if (tool.state === "registered") return aliasText;
  if (tool.state === "stale") return `${aliasText} [stale]`;
  return `${aliasText} [conflict${tool.reason ? `: ${tool.reason}` : ""}]`;
}

function formatDuration(valueMs: number): string {
  if (valueMs <= 1000) return "1s";
  return `${Math.ceil(valueMs / 1000)}s`;
}
function buildFooterSuffix(servers: McpServerSnapshot[]): string | undefined {
  if (servers.some((server) => server.enabled && (server.state === "starting" || server.state === "reconnecting"))) {
    return "connecting";
  }
  if (servers.some((server) => server.enabled && server.state === "failed")) {
    return "connection failed";
  }
  return undefined;
}
