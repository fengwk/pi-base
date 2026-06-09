import type { SubagentConfig } from "./types.js";
import { getSubagentConfig } from "./registry.js";
import { preloadSubagentSkills } from "./skills.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildSkillsBlock(config: SubagentConfig, cwd: string): string | undefined {
  if (config.skills.length === 0) return undefined;
  const loaded = preloadSubagentSkills(config.skills, cwd);
  if (loaded.length === 0) return undefined;
  const lines = ["<skills>"];
  for (const skill of loaded) {
    lines.push(`  <skill name=\"${escapeXml(skill.name)}\">`);
    lines.push(...skill.content.split("\n").map((line) => `    ${line}`));
    lines.push("  </skill>");
  }
  lines.push("</skills>");
  return lines.join("\n");
}

function buildSubagentsBlock(config: SubagentConfig, registry: Map<string, SubagentConfig>): string | undefined {
  if (config.subagents.length === 0) return undefined;
  const body = config.subagents
    .map((name) => {
      const child = getSubagentConfig(registry, name);
      const description = child?.description ?? "Subagent configuration not found.";
      return `  <subagent name=\"${escapeXml(name)}\">${escapeXml(description)}</subagent>`;
    })
    .join("\n");
  /* v8 ignore next -- trivial string assembly return */
  return `<subagents>\n${body}\n</subagents>`;
}

export function buildSubagentSystemPrompt(config: SubagentConfig, registry: Map<string, SubagentConfig>, cwd: string): string {
  const sections = [
    buildSkillsBlock(config, cwd),
    buildSubagentsBlock(config, registry),
    config.body.trim(),
  ].filter((value): value is string => Boolean(value && value.trim()));
  return sections.join("\n\n");
}
