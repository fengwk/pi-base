import { resolve } from "node:path";
import { listSubagentConfigs, loadSubagentRegistry } from "./registry.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function hasAvailableSubagents(cwd: string): boolean {
  try {
    return loadSubagentRegistry(resolve(cwd)).size > 0;
  } catch {
    return false;
  }
}

export function buildSubagentGuide(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const lines = ["<available_subagents>"];

  try {
    const registry = loadSubagentRegistry(resolvedCwd);
    if (registry.size === 0) return "";

    for (const config of listSubagentConfigs(registry)) {
      lines.push("  <subagent>");
      lines.push(`    <name>${escapeXml(config.name)}</name>`);
      lines.push(`    <description>${escapeXml(config.description)}</description>`);
      lines.push("  </subagent>");
    }
    lines.push("</available_subagents>");
    return lines.join("\n");
  } catch {
    return "";
  }
}
