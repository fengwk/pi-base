// Minimal deterministic stdio MCP peer: no network, credentials, or timing-based responses.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (event) => appendFileSync(process.argv[2], JSON.stringify({ pid: process.pid, ...event }) + "\n");
log({ type: "start" });
process.on("exit", () => log({ type: "exit" }));
process.on("SIGTERM", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
  } else if (method === "tools/list") {
    reply(id, { tools: [{
      name: "echo",
      description: "Echo fixture text; fail returns an MCP error and wait blocks until cancelled.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    }] });
  } else if (method === "tools/call") {
    log({ type: "call", text: params.arguments.text });
    if (params.arguments.text !== "wait") {
      reply(id, { content: [{ type: "text", text: params.arguments.text === "fail" ? "fixture failure" : params.arguments.text }],
        ...(params.arguments.text === "fail" ? { isError: true } : {}) });
    }
  } else if (method === "notifications/cancelled") {
    log({ type: "cancel" });
  } else if (id !== undefined) {
    reply(id, {});
  }
});
