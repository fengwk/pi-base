import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SubagentConfig } from "./types.js";
const SUBAGENT_DIRNAME = "subagents";
const LEGACY_SUBAGENT_DIRNAME = "agents";

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function ensureNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
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
  const subagents = toStringArray(frontmatter.subagents, `${filePath}: frontmatter.subagents`);
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    throw new Error(`${filePath}: markdown body must not be empty.`);
  }

  return {
    name,
    description,
    tools,
    skills,
    subagents,
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

export function loadSubagentRegistry(cwd: string): Map<string, SubagentConfig> {
  const resolvedCwd = resolve(cwd);
  const registry = new Map<string, SubagentConfig>();
  // Prefer the new `subagents` directories while keeping the previous `agents`
  // locations readable for compatibility during migration.
  loadDirectory(join(getAgentDir(), LEGACY_SUBAGENT_DIRNAME), "global", registry);
  loadDirectory(join(getAgentDir(), SUBAGENT_DIRNAME), "global", registry);
  loadDirectory(join(resolvedCwd, ".pi", LEGACY_SUBAGENT_DIRNAME), "project", registry);
  loadDirectory(join(resolvedCwd, ".pi", SUBAGENT_DIRNAME), "project", registry);
  return registry;
}

export function getSubagentConfig(registry: Map<string, SubagentConfig>, name: string): SubagentConfig | undefined {
  return registry.get(normalizeName(name));
}

export function listSubagentConfigs(registry: Map<string, SubagentConfig>): SubagentConfig[] {
  return Array.from(registry.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeSubagentName(name: string): string {
  return normalizeName(name);
}
