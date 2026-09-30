import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// A configured extension stand-in for pi-base identity; the integration test supplies the
// current instance marker. This keeps unrelated index/agent policy out of native MCP coverage.
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "task",
    label: "Nested MCP fixture",
    description: "Call native MCP through the official nested tool pipeline.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, args, _signal, _update, ctx) {
      const result = await ctx.executeTool("mcp__fixture__echo", args);
      return { content: result.result.content, details: { isError: result.isError } };
    },
  });
  const record = (event: ToolCallEvent | ToolResultEvent, ctx: ExtensionContext) => {
    appendFileSync(process.env.NATIVE_MCP_HOOK_LOG!, JSON.stringify({
      type: event.type, sessionId: ctx.sessionManager.getSessionId(), name: event.toolName,
      id: event.toolCallId, parent: event.parentToolCallId,
    }) + "\n");
  };
  pi.on("tool_call", record);
  pi.on("tool_result", record);
}
