import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { listSubagentConfigs, loadSubagentRegistry, resolveProjectSubagentDir } from "./registry.js";

export function buildSubagentGuide(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const projectDir = resolveProjectSubagentDir(resolvedCwd);
  const globalDir = join(getAgentDir(), "subagents");
  const lines = [
    "## Available task subagents",
    "Use only these exact `subagent` names when calling `task`. Do not invent names or reuse names from other runtimes.",
  ];

  try {
    const registry = loadSubagentRegistry(resolvedCwd);
    if (registry.size === 0) {
      lines.push("- None configured for this workspace.");
      lines.push(`- Project search path: \`${projectDir}\``);
      lines.push(`- Global search path: \`${globalDir}\``);
      lines.push("- If no subagent is configured, do not call `task`; continue in the main session or ask the user to add a subagent definition first.");
      return lines.join("\n");
    }

    for (const config of listSubagentConfigs(registry)) {
      lines.push(`- \`${config.name}\` — ${config.description}`);
    }

    lines.push(
      "",
      "Lookup order:",
      `- Project override: \`${projectDir}\``,
      `- Global fallback: \`${globalDir}\``,
    );
    return lines.join("\n");
  } catch (error) {
    lines.push("- Subagent discovery failed.");
    lines.push(`- Error: ${(error as Error).message}`);
    lines.push(`- Fix the subagent definitions under \`${projectDir}\` or \`${globalDir}\` before calling \`task\`.`);
    return lines.join("\n");
  }
}
