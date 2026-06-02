import { readFileSync } from "node:fs";

const cache = new Map<string, string>();

export function loadToolDescription(name: string, replacements?: Record<string, string>): string {
  const key = JSON.stringify([name, replacements ?? {}]);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let text = readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8").trim();
  for (const [placeholder, value] of Object.entries(replacements ?? {})) {
    text = text.replaceAll(`\${placeholder}`, value);
  }
  cache.set(key, text);
  return text;
}

export function loadToolPromptSnippet(name: string, replacements?: Record<string, string>): string {
  const description = loadToolDescription(name, replacements);
  return description.split("\n").find((line) => line.trim().length > 0)?.trim() ?? name;
}
