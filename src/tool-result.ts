import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { hasPiBaseToolErrorMarker } from "./tool-error-marker.js";

function combineTextContent(result: Pick<AgentToolResult<any>, "content">): string {
  return Array.isArray(result?.content)
    ? result.content.filter((item: any) => item?.type === "text").map((item: any) => String(item.text ?? "")).join("\n\n")
    : "";
}

function inferBashError(text: string): boolean {
  if (!text.startsWith("Error:")) return false;
  if (!text.includes("\n")) return true;
  if (/\n\nCommand exited with code \d+\s*$/i.test(text)) return true;
  if (/\n\nCommand timed out(?: after .*?)?\s*$/i.test(text)) return true;
  return false;
}

export function inferToolResultIsError(toolName: string, result: Pick<AgentToolResult<any>, "content" | "details"> & { isError?: boolean }): boolean {
  if (result.isError === true) return true;
  if (hasPiBaseToolErrorMarker(result.details)) return true;
  const text = combineTextContent(result).trimStart();
  if (!text) return false;

  if (toolName === "edit") {
    return text.startsWith("Error:") || text.startsWith("Could not find") || text.startsWith("Found ") || text.startsWith("File ") || text.startsWith("No changes") || text.startsWith("old_string") || text.startsWith("new_string");
  }

  if (toolName === "bash") {
    return inferBashError(text);
  }

  if (toolName === "read" || toolName === "write" || toolName === "grep" || toolName.startsWith("lsp_")) {
    return text.startsWith("Error:");
  }

  return false;
}
