import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SubagentConfig } from "./types.js";

const SUBAGENT_DIRNAME = "subagents";
const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function ensureNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string.`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function toStringArray(value: unknown, path: string): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be a string or an array of strings.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function parseThinkingLevel(value: unknown, path: string): ThinkingLevel | undefined {
  const normalized = readOptionalString(value, path);
  if (!normalized) return undefined;
  if (!VALID_THINKING_LEVELS.has(normalized as ThinkingLevel)) {
    throw new Error(`${path} must be one of: ${Array.from(VALID_THINKING_LEVELS).join(", ")}.`);
  }
  return normalized as ThinkingLevel;
}

function parseOptionalModelIdentifier(value: unknown, path: string): string | undefined {
  const normalized = readOptionalString(value, path);
  if (!normalized) return undefined;
  const parts = normalized.split("/").map((item) => item.trim()).filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`${path} must be an exact "provider/model" identifier.`);
  }
  return `${parts[0]}/${parts[1]}`;
}

function parseSubagentFile(filePath: string, source: "project" | "global"): SubagentConfig {
  const raw = readFileSync(filePath, "utf8");
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
  const fileStem = basename(filePath, ".md");
  const name = ensureNonEmptyString(frontmatter.name, `${filePath}: frontmatter.name`);
  if (normalizeName(name) !== normalizeName(fileStem)) {
    throw new Error(`${filePath}: frontmatter.name must match the file name (${fileStem}).`);
  }

  const description = ensureNonEmptyString(frontmatter.description, `${filePath}: frontmatter.description`);
  const tools = toStringArray(frontmatter.tools, `${filePath}: frontmatter.tools`);
  if (tools.length === 0) {
    throw new Error(`${filePath}: frontmatter.tools must list at least one tool.`);
  }

  const skills = toStringArray(frontmatter.skills, `${filePath}: frontmatter.skills`);
  const model = parseOptionalModelIdentifier(frontmatter.model, `${filePath}: frontmatter.model`);
  const thinking = parseThinkingLevel(frontmatter.thinking, `${filePath}: frontmatter.thinking`);
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    throw new Error(`${filePath}: markdown body must not be empty.`);
  }

  return {
    name,
    description,
    tools,
    skills,
    model,
    thinking,
    body: trimmedBody,
    filePath,
    source,
  };
}

function loadDirectory(dir: string, source: "project" | "global", registry: Map<string, SubagentConfig>): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((entry) => entry.endsWith(".md")).sort();
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = join(dir, file);
    const config = parseSubagentFile(filePath, source);
    registry.set(normalizeName(config.name), config);
  }
}

export function resolveProjectSubagentDir(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  let dir = resolvedCwd;
  let previous = "";
  while (dir !== previous) {
    const candidate = join(dir, ".pi", SUBAGENT_DIRNAME);
    if (existsSync(candidate)) return candidate;
    previous = dir;
    dir = dirname(dir);
  }
  return join(resolvedCwd, ".pi", SUBAGENT_DIRNAME);
}

export function loadSubagentRegistry(cwd: string): Map<string, SubagentConfig> {
  const resolvedCwd = resolve(cwd);
  const registry = new Map<string, SubagentConfig>();
  loadDirectory(join(getAgentDir(), SUBAGENT_DIRNAME), "global", registry);
  loadDirectory(resolveProjectSubagentDir(resolvedCwd), "project", registry);
  return registry;
}

export function getSubagentConfig(registry: Map<string, SubagentConfig>, name: string): SubagentConfig | undefined {
  return registry.get(normalizeName(name));
}

export function listSubagentConfigs(registry: Map<string, SubagentConfig>): SubagentConfig[] {
  return Array.from(registry.values()).sort((left, right) => left.name.localeCompare(right.name));
}
