import type { SubagentConfig } from "./types.js";
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

  const lines = ["<skills>"];
  for (const skill of preloadSubagentSkills(config.skills, cwd)) {
    lines.push(`  <skill name="${escapeXml(skill.name)}">`);
    lines.push(...skill.content.split("\n").map((line) => `    ${line}`));
    lines.push("  </skill>");
  }
  lines.push("</skills>");
  return lines.join("\n");
}

export function buildSubagentSystemPromptCore(config: SubagentConfig, cwd: string): string {
  return [buildSkillsBlock(config, cwd), config.body.trim()]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n\n");
}
