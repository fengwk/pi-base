import { readFileSync } from "node:fs";

const cache = new Map<string, string>();

export function loadToolDescription(name: string, replacements?: Record<string, string>): string {
  const key = JSON.stringify([name, replacements ?? {}]);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let text = readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8").trim();
  for (const [placeholder, value] of Object.entries(replacements ?? {})) {
    text = text.replaceAll(`\${${placeholder}}`, value);
  }
  cache.set(key, text);
  return text;
}

export function loadToolPromptSnippet(name: string, replacements?: Record<string, string>): string {
  const description = loadToolDescription(name, replacements);
  return description.split("\n").find((line) => line.trim().length > 0)?.trim() ?? name;
}

/** In base.md each section's heading lists the tools that can satisfy its rule. */
export function renderBaseToolGuide(toolNames: readonly string[]): string {
  const available = new Set(toolNames);
  const [heading = "", ...sections] = loadToolDescription("base").split(/\r?\n## /);
  const rules = sections.flatMap((section) => {
    const [tools = "", ...lines] = section.split(/\r?\n/);
    const enabled = tools.trim().split(/\s+/).filter((name) => available.has(name));
    if (enabled.length === 0) return [];
    return [lines.join("\n").trim()
      .replace("${tools}", enabled.map((name) => `\`${name}\``).join(" or "))
      .replace("${modifyFiles}", available.has("write") ? "create or modify files" : "modify files")
      .replace("${readMatches}", available.has("read") ? "; use `read` on matches when context is needed" : "")
      .replace("${readExisting}", available.has("read") ? "; read existing files first" : "")];
  });
  return rules.length > 0 ? `${heading.trim()}\n\n${rules.join("\n")}` : "";
}
