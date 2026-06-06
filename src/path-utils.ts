import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

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
  const expanded = expandHomePath(stripAtPrefix(filePath));
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

export function resolveToolWorkdir(workdir: unknown, cwd: string): { rawWorkdir: string; cwd: string } {
  if (workdir === undefined || workdir === null) throw new Error("workdir is required.");
  const rawWorkdir = stripAtPrefix(String(workdir));
  if (rawWorkdir.trim().length === 0) throw new Error("workdir is required.");
  return { rawWorkdir, cwd: resolveToCwd(rawWorkdir, cwd) };
}
