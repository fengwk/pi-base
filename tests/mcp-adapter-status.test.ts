import { describe, expect, it } from "vitest";
import { buildMcpToolName, createMcpToolDefinition, resolveMcpToolPrefix } from "../src/mcp/adapter.js";
import { renderMcpFooterStatus, renderMcpStatusTree } from "../src/mcp/status.js";
import { getText } from "./helpers.js";

describe("mcp adapter", () => {
  it("builds MCP tool aliases from default, empty, and custom prefixes", () => {
    // Intent: alias naming is part of the user-visible tool contract and must
    // remain stable across MCP reconnects.
    expect(resolveMcpToolPrefix("docs", undefined)).toBe("docs");
    expect(resolveMcpToolPrefix("docs", "")).toBe("");
    expect(buildMcpToolName("docs", "search", undefined)).toBe("docs_search");
    expect(buildMcpToolName("docs", "search", "")).toBe("search");
    expect(buildMcpToolName("docs", "search", "kb")).toBe("kb_search");
  });

  it("normalizes MCP execution results, errors, structured content, and cancellation", async () => {
    // Intent: remote MCP servers can return mixed content shapes; pi-base must
    // turn them into text blocks the model can consume and mark failures.
    const calls: string[] = [];
    const tool = createMcpToolDefinition({
      serverKey: "docs",
      serverConfig: { type: "remote", transport: "streamable-http", url: "https://example.com/mcp" },
      tool: { name: "lookup" },
      callTool: async (_server, _tool, args) => {
        calls.push(String(args.mode));
        if (args.mode === "error") return { isError: true, content: [{ type: "blob", data: { reason: "bad" } }] };
        if (args.mode === "structured") return { structuredContent: { answer: 42 } };
        if (args.mode === "empty") return {};
        if (args.mode === "throw") throw new Error("transport failed");
        return { content: [{ type: "text", text: "plain" }, { type: "image" }] };
      },
    });

    const ok = await tool.execute("1", { mode: "ok" }, undefined, undefined, {} as any);
    expect(getText(ok)).toBe("plain");
    expect(ok.content.map((item: any) => item.text)).toContain("[image content omitted]");
    expect(ok.details).toEqual({ server: "docs", tool: "lookup" });

    const structured = await tool.execute("2", { mode: "structured" }, undefined, undefined, {} as any);
    expect(getText(structured)).toContain('"answer": 42');

    const empty = await tool.execute("3", { mode: "empty" }, undefined, undefined, {} as any);
    expect(getText(empty)).toBe("No content returned.");

    const remoteError = await tool.execute("4", { mode: "error" }, undefined, undefined, {} as any);
    expect((remoteError as any).isError).toBe(true);
    expect(getText(remoteError)).toContain('"reason": "bad"');

    const thrown = await tool.execute("5", { mode: "throw" }, undefined, undefined, {} as any);
    expect((thrown as any).isError).toBe(true);
    expect(getText(thrown)).toBe("MCP Error: transport failed");

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await tool.execute("6", { mode: "ok" }, aborted.signal, undefined, {} as any);
    expect((cancelled as any).isError).toBe(true);
    expect(getText(cancelled)).toBe("Tool call cancelled.");
    expect(calls).toEqual(["ok", "structured", "empty", "error", "throw"]);
  });
});

describe("mcp status rendering", () => {
  it("renders footer suffixes, retry durations, stale tools, conflicts, and empty states", () => {
    // Intent: /mcp-status is the user's only visibility into MCP lifecycle
    // problems, so state, retry, stale and conflict details must be explicit.
    expect(renderMcpFooterStatus({ enabledServers: 0, connectedServers: 0, servers: [] })).toBeUndefined();
    expect(renderMcpStatusTree({ enabledServers: 0, connectedServers: 0, servers: [] })).toContain("(no enabled servers)");

    const snapshot: any = {
      enabledServers: 2,
      connectedServers: 1,
      servers: [
        {
          key: "docs",
          enabled: true,
          state: "reconnecting",
          type: "remote",
          transport: "sse",
          prefix: "docs",
          nextRetryInMs: 1200,
          lastError: "network down",
          tools: [
            { remoteName: "search", aliasName: "docs_search", state: "registered" },
            { remoteName: "old", aliasName: "docs_old", state: "stale" },
          ],
        },
        {
          key: "local",
          enabled: true,
          state: "failed",
          type: "local",
          prefix: "",
          tools: [
            { remoteName: "run", aliasName: "run", state: "conflict", reason: "tool name already exists" },
          ],
        },
      ],
    };

    expect(renderMcpFooterStatus(snapshot)).toBe("MCP: 1/2 servers connecting");
    const tree = renderMcpStatusTree(snapshot);
    expect(tree).toContain('docs [reconnecting] type=sse prefix="docs" retry_in=2s error="network down"');
    expect(tree).toContain("docs_old (remote: old) [stale]");
    expect(tree).toContain("run [conflict: tool name already exists]");
  });
});
