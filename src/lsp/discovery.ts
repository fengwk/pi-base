import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

export interface LspServerConfig {
  id: string;
  command: string[];
  extensions: string[];
  rootMarkers?: string[];
  firstMatchMarkers?: string[];
  requestTimeoutMs?: number;
}

/**
 * One LSP server entry, fully user-defined. `pi-base` ships no built-in
 * server table; the only source of truth is the user's `lsp.servers` map.
 */
export interface LspServerEntry {
  /** Executable + args. The first element is searched in `PATH` then `lsp.searchPaths`. Use this for server-specific flags such as `jdtls --jvm-arg=...`. */
  command: string[];
  /** File extensions this server handles, e.g. `[".ts", ".tsx"]`. */
  extensions: string[];
  /** Optional workspace root markers (multi-module projects: topmost wins). */
  rootMarkers?: string[];
  /** Optional workspace root markers (first match wins). */
  firstMatchMarkers?: string[];
  /**
   * Optional per-request timeout in milliseconds. Applies to every JSON-RPC
   * request sent to the server and to the diagnostics wait. Defaults to 15000.
   * Increase for slow servers like `gopls` on large workspaces.
   */
  requestTimeoutMs?: number;
}

export interface LspDiscoveryConfig {
  /** Extra directories searched (in addition to `PATH`) for server executables. */
  searchPaths?: string[];
  /** All LSP servers that `pi-base` may launch. To "disable" a server, omit it. */
  servers?: Record<string, LspServerEntry>;
}

export type LspSupportInfo =
  | { supported: false }
  | { supported: true; language: string; available: true }
  | { supported: true; language: string; available: false; reason: "not-installed" };

function buildServerEntryExample(id: string, command: string[]): LspServerEntry {
  if (command.length === 0) return { command: ["/absolute/path/to/lsp-server"], extensions: [] };
  const [binary, ...rest] = command;
  const basename = binary.split(/[\\/]/).filter(Boolean).pop() ?? binary;
  return { command: [`/absolute/path/to/${basename}`, ...rest], extensions: [] };
}

function isRunnableCommandFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExecutableSuffixes(): string[] {
  if (process.platform !== "win32") return [""];
  const fromEnv = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return ["", ...fromEnv];
}

/**
 * Resolves LSP server configuration and command paths for a specific
 * `LspDiscoveryConfig` snapshot. Each instance owns its own caches, so two
 * resolvers with different configs cannot leak state into each other.
 *
 * The extension creates a resolver per request (keyed by `ctx.cwd` to avoid
 * re-reading `settings.json` on every tool call) and passes it down to
 * `LspManager.getClient(filePath, resolver)`. This matches the opencode
 * `lsp-tools` plugin: there is no module-level mutable state, and switching
 * projects does not carry over a previous project's servers or search paths.
 */
export class LspDiscoveryResolver {
  private commandPathCache = new Map<string, string | null>();
  private resolveOnPathCache = new Map<string, string | null>();
  private serverInstalledCache = new Map<string, boolean>();

  constructor(private readonly config: LspDiscoveryConfig) {}

  /** Read-only view of the config this resolver was built from. */
  getConfig(): LspDiscoveryConfig {
    return this.config;
  }

  private discoveryCacheKey(cmd: string): string {
    return JSON.stringify({
      platform: process.platform,
      cmd,
      path: process.env.PATH ?? "",
      searchPaths: this.config.searchPaths ?? [],
    });
  }

  private serverInstallCacheKey(command: string[]): string {
    return JSON.stringify({
      platform: process.platform,
      command,
      path: process.env.PATH ?? "",
      searchPaths: this.config.searchPaths ?? [],
    });
  }

  /**
   * Probe command resolution order:
   *   1. absolute / relative path passed in -> existsSync check
   *   2. PATH (with executable extension on win32)
   *   3. searchPaths from discovery config
   */
  findCommandPath(cmd: string): string | null {
    if (cmd.includes("/") || cmd.includes("\\")) {
      return isRunnableCommandFile(cmd) ? cmd : null;
    }
    const cacheKey = this.discoveryCacheKey(cmd);
    if (this.commandPathCache.has(cacheKey)) return this.commandPathCache.get(cacheKey) ?? null;
    const pathEnv = process.env.PATH || "";
    const pathSep = process.platform === "win32" ? ";" : ":";
    const suffixes = windowsExecutableSuffixes();
    const candidates: string[] = [];
    for (const base of pathEnv.split(pathSep)) {
      if (!base) continue;
      for (const suffix of suffixes) candidates.push(`${join(base, cmd)}${suffix}`);
    }
    for (const base of this.config.searchPaths ?? []) {
      if (!base) continue;
      for (const suffix of suffixes) candidates.push(`${join(base, cmd)}${suffix}`);
    }
    for (const candidate of candidates) {
      if (isRunnableCommandFile(candidate)) {
        this.commandPathCache.set(cacheKey, candidate);
        return candidate;
      }
    }
    this.commandPathCache.set(cacheKey, null);
    return null;
  }

  /** Try `which`-style resolution using the OS. Falls back to our own scan. */
  private resolveOnPath(cmd: string): string | null {
    const cacheKey = this.discoveryCacheKey(cmd);
    if (this.resolveOnPathCache.has(cacheKey)) return this.resolveOnPathCache.get(cacheKey) ?? null;
    try {
      const which = process.platform === "win32" ? "where" : "which";
      const output = execFileSync(which, [cmd], { stdio: ["ignore", "pipe", "ignore"] });
      const first = output.toString().split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
      if (first && isRunnableCommandFile(first)) {
        this.resolveOnPathCache.set(cacheKey, first);
        return first;
      }
    } catch {
      // fall through
    }
    const resolved = this.findCommandPath(cmd);
    this.resolveOnPathCache.set(cacheKey, resolved);
    return resolved;
  }

  /** Check if an LSP server command is reachable. Honors explicit overrides. */
  isServerInstalled(command: string[]): boolean {
    if (command.length === 0) return false;
    const cacheKey = this.serverInstallCacheKey(command);
    if (this.serverInstalledCache.has(cacheKey)) return this.serverInstalledCache.get(cacheKey) ?? false;
    const installed = command[0].includes("/") || command[0].includes("\\")
      ? isRunnableCommandFile(command[0])
      : this.resolveOnPath(command[0]) !== null;
    this.serverInstalledCache.set(cacheKey, installed);
    return installed;
  }

  private resolveCommand(command: string[]): string[] {
    if (command.length === 0) return command;
    if (command[0].includes("/") || command[0].includes("\\")) {
      return isRunnableCommandFile(command[0]) ? [command[0], ...command.slice(1)] : command;
    }
    const resolved = this.resolveOnPath(command[0]);
    return resolved ? [resolved, ...command.slice(1)] : command;
  }

  supportsLsp(filePath: string): LspSupportInfo {
    const ext = extname(filePath);
    for (const [id, config] of Object.entries(this.config.servers ?? {})) {
      if (!config.extensions.includes(ext)) continue;
      const command = this.resolveCommand(config.command);
      if (!this.isServerInstalled(command)) {
        return { supported: true, language: id, available: false, reason: "not-installed" };
      }
      return { supported: true, language: id, available: true };
    }
    return { supported: false };
  }

  findWorkspaceRoot(filePath: string, server: LspServerConfig): string {
    let dir = dirname(resolve(filePath));
    let prev = "";
    let topmostRoot: string | null = null;
    let firstRoot: string | null = null;
    while (dir !== prev) {
      for (const marker of server.rootMarkers ?? []) {
        if (existsSync(join(dir, marker))) topmostRoot = dir;
      }
      if (firstRoot === null) {
        for (const marker of server.firstMatchMarkers ?? []) {
          if (existsSync(join(dir, marker))) {
            firstRoot = dir;
            break;
          }
        }
      }
      prev = dir;
      dir = dirname(dir);
    }
    return topmostRoot || firstRoot || dirname(resolve(filePath));
  }

  findServerForFile(filePath: string): LspServerConfig {
    const ext = extname(filePath);
    for (const [id, config] of Object.entries(this.config.servers ?? {})) {
      if (config.extensions.includes(ext)) {
        const command = this.resolveCommand(config.command);
        if (!this.isServerInstalled(command)) {
          const hint = `Hint: Add to .pi/pi-base/settings.json or ~/.pi/agent/pi-base/settings.json:\n${JSON.stringify({ lsp: { servers: { [id]: buildServerEntryExample(id, config.command) } } }, null, 2)}`;
          throw new Error(`LSP server '${id}' is not installed for ${filePath}. Install ${config.command[0]} on PATH${(this.config.searchPaths ?? []).length > 0 ? " (or via lsp.searchPaths)" : ""}, or update lsp.servers.${id} in pi-base settings.\n${hint}`);
        }
        return { id, command, extensions: config.extensions, rootMarkers: config.rootMarkers, firstMatchMarkers: config.firstMatchMarkers, requestTimeoutMs: config.requestTimeoutMs };
      }
    }
    throw new Error(`No LSP server configured for ${filePath}. Configure it under lsp.servers in pi-base settings.`);
  }
}

/** Helper: read `JAVA_HOME_<version>` and `JAVA_HOME` env vars, prefer the highest declared version. */
export function findBestJavaHome(): string | null {
  const candidates = [
    process.env.JAVA_HOME_22,
    process.env.JAVA_HOME_21,
    process.env.JAVA_HOME_20,
    process.env.JAVA_HOME_19,
    process.env.JAVA_HOME_18,
    process.env.JAVA_HOME_17,
    process.env.JAVA_HOME_11,
    process.env.JAVA_HOME_8,
    process.env.JAVA_HOME,
  ];
  return candidates.find((p) => typeof p === "string" && p.length > 0 && existsSync(p)) ?? null;
}
