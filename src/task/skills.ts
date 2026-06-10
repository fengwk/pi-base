import type { Dirent } from "node:fs";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface LoadedSkill {
  name: string;
  content: string;
}

function isUnsafeName(name: string): boolean {
  return name.includes("/") || name.includes("\\") || name.includes("..") || name.includes("\0");
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeRead(path: string): string | undefined {
  if (!existsSync(path) || isSymlink(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function findFlatSkill(root: string, name: string): string | undefined {
  const content = safeRead(join(root, `${name}.md`));
  return content?.trim();
}

function findDirectorySkill(root: string, name: string): string | undefined {
  if (!existsSync(root) || isSymlink(root)) return undefined;
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true }) as unknown as Dirent[];
    } catch {
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (isSymlink(path)) continue;
      const skillFile = join(path, "SKILL.md");
      const isSkillDirectory = existsSync(skillFile);
      if (isSkillDirectory) {
        if (entry.name === name) {
          return safeRead(skillFile)?.trim();
        }
        continue;
      }
      queue.push(path);
    }
  }
  return undefined;
}

function loadSkillContent(name: string, cwd: string): string {
  if (isUnsafeName(name)) {
    return `(Skill "${name}" skipped: name contains path traversal characters)`;
  }

  const roots = [
    join(cwd, ".pi", "skills"),
    join(cwd, ".agents", "skills"),
    join(getAgentDir(), "skills"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".pi", "skills"),
  ];

  for (const root of roots) {
    const flat = findFlatSkill(root, name);
    if (flat !== undefined) return flat;
    const directory = findDirectorySkill(root, name);
    if (directory !== undefined) return directory;
  }

  return `(Skill "${name}" not found in project or global skill locations)`;
}

export function preloadSubagentSkills(skillNames: string[], cwd: string): LoadedSkill[] {
  return skillNames.map((name) => ({ name, content: loadSkillContent(name, cwd) }));
}
