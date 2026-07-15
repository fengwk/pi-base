import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

export function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

export function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  if (value === "$HOME") return homedir();
  if (value.startsWith("$HOME/") || value.startsWith("$HOME\\")) return join(homedir(), value.slice(6));
  if (value === "${HOME}") return homedir();
  if (value.startsWith("${HOME}/") || value.startsWith("${HOME}\\")) return join(homedir(), value.slice(8));
  return value;
}

export function isHomeShortcutPath(value: string): boolean {
  return value === "~"
    || value.startsWith("~/")
    || value.startsWith("~\\")
    || value === "$HOME"
    || value.startsWith("$HOME/")
    || value.startsWith("$HOME\\")
    || value === "${HOME}"
    || value.startsWith("${HOME}/")
    || value.startsWith("${HOME}\\");
}

export function resolveToCwd(filePath: string, cwd: string): string {
  // Tool paths accept either separator on every platform. Normalize before
  // resolution so execution, permission matching, and context tracking cannot
  // interpret the same input as different filesystem targets.
  const normalized = normalizeSlashes(stripAtPrefix(filePath));
  const expanded = expandHomePath(normalized);
  return resolvePath(cwd, expanded);
}

export interface ResolvedToolWorkdir {
  rawWorkdir: string;
  cwd: string;
  usedDefault: boolean;
}

export function describeToolWorkdirForDisplay(workdir: unknown, cwd?: string): { rawWorkdir: string; usedDefault: boolean } {
  if (workdir === undefined || workdir === null) return { rawWorkdir: cwd ?? ".", usedDefault: true };
  const rawWorkdir = stripAtPrefix(String(workdir));
  if (rawWorkdir.trim().length === 0) return { rawWorkdir: "<invalid-workdir>", usedDefault: false };
  return { rawWorkdir, usedDefault: false };
}

export function resolveToolWorkdir(workdir: unknown, cwd: string): ResolvedToolWorkdir {
  if (workdir === undefined || workdir === null) return { rawWorkdir: ".", cwd, usedDefault: true };
  const rawWorkdir = stripAtPrefix(String(workdir));
  if (rawWorkdir.trim().length === 0) throw new Error("workdir must be a non-empty string when provided.");
  return { rawWorkdir, cwd: resolveToCwd(rawWorkdir, cwd), usedDefault: false };
}
