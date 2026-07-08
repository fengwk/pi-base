/**
 * Internal copies of selected helpers from `@earendil-works/pi-coding-agent`.
 *
 * These are vendored here to keep `pi-base` self-contained at runtime. The
 * upstream package places its tools (fd/rg) and child-process bookkeeping in
 * files that are not exposed via the package's `exports` field, and the
 * `pi` package manager installs git extensions with `npm install --omit=dev`,
 * so we cannot reliably reach the upstream sources from inside the extension.
 *
 * Only public-API or behaviorally trivial helpers are duplicated. Anything
 * that ships as a stable export of `@earendil-works/pi-coding-agent` should
 * continue to be imported from there.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// =============================================================================
// Process / child bookkeeping
// =============================================================================

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * On Windows, daemonized descendants can inherit the child's stdout/stderr pipe
 * handles. In that case the child emits `exit`, but `close` can hang forever even
 * though the original process is already gone. We wait briefly for stdio to end,
 * then forcibly stop tracking the inherited handles.
 */
export function waitForChildProcess(child: import("node:child_process").ChildProcess): Promise<number | null> {
  const EXIT_STDIO_GRACE_MS = 100;
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
    };
    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) {
        postExitTimer = setTimeout(() => finalize(code), EXIT_STDIO_GRACE_MS);
      }
    };
    const onClose = (code: number | null) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

// =============================================================================
// Shell environment
// =============================================================================

function getBinDir(): string {
  // Mirrors `@earendil-works/pi-coding-agent`'s `getBinDir()`: default agent
  // dir is `~/.pi/agent`, binaries live under `bin/`. The `PI_CODING_AGENT_DIR`
  // env var is honored to match upstream.
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = envDir ? expandTildePath(envDir) : join(homedir(), ".pi", "agent");
  return join(agentDir, "bin");
}

function expandTildePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/**
 * Return a copy of `process.env` with the binary directory (`~/.pi/agent/bin`)
 * prepended to `PATH` so spawned shells can find downloaded `fd` / `rg`.
 */
export function getShellEnv(): NodeJS.ProcessEnv {
  const binDir = getBinDir();
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const currentPath = process.env[pathKey] ?? "";
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  const hasBinDir = pathEntries.includes(binDir);
  const updatedPath = hasBinDir
    ? currentPath
    : [binDir, currentPath].filter(Boolean).join(delimiter);
  return {
    ...process.env,
    [pathKey]: updatedPath,
  };
}

// `delimiter` is platform-dependent; import lazily to keep the module top tidy.
import { delimiter } from "node:path";

// =============================================================================
// Tool manager (fd / rg)
// =============================================================================

type SupportedTool = "fd" | "rg";

interface ToolConfig {
  name: string;
  repo: string;
  binaryName: string;
  systemBinaryNames: string[];
  tagPrefix: string;
  getAssetName: (version: string, plat: NodeJS.Platform, architecture: string) => string | null;
}

const TOOLS: Record<SupportedTool, ToolConfig> = {
  fd: {
    name: "fd",
    repo: "sharkdp/fd",
    binaryName: "fd",
    systemBinaryNames: ["fd", "fdfind"],
    tagPrefix: "v",
    getAssetName: (version, plat, architecture) => {
      if (plat === "darwin") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
      }
      if (plat === "linux") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
      }
      if (plat === "win32") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
      }
      return null;
    },
  },
  rg: {
    name: "ripgrep",
    repo: "BurntSushi/ripgrep",
    binaryName: "rg",
    systemBinaryNames: ["rg"],
    tagPrefix: "",
    getAssetName: (version, plat, architecture) => {
      if (plat === "darwin") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
      }
      if (plat === "linux") {
        if (architecture === "arm64") {
          return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
        }
        return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
      }
      if (plat === "win32") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
      }
      return null;
    },
  },
};

const TOOLS_DIR = getBinDir();
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

function isOfflineModeEnabled(): boolean {
  const value = process.env.PI_OFFLINE;
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function logInfo(silent: boolean, msg: string): void {
  if (!silent) console.log(msg);
}

function logWarn(silent: boolean, msg: string): void {
  if (!silent) console.warn(msg);
}

function commandExists(cmd: string): boolean {
  try {
    const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
    return result.error === undefined || result.error === null;
  } catch {
    return false;
  }
}

/** Get the path to a tool (system-wide or in the managed bin dir). */
export function getToolPath(tool: SupportedTool): string | null {
  const config = TOOLS[tool];
  if (!config) return null;
  const localPath = join(TOOLS_DIR, config.binaryName + (process.platform === "win32" ? ".exe" : ""));
  if (existsSync(localPath)) return localPath;
  for (const systemBinaryName of config.systemBinaryNames) {
    if (commandExists(systemBinaryName)) return systemBinaryName;
  }
  return null;
}

async function getLatestVersion(repo: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { "User-Agent": "pi-base" },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  const data = (await response.json()) as { tag_name: string };
  return data.tag_name.replace(/^v/, "");
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
  if (!response.body) throw new Error("No response body");
  const fileStream = createWriteStream(dest);
  await pipeline(Readable.fromWeb(response.body), fileStream);
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isFile() && entry.name === binaryFileName) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return null;
}

function formatSpawnFailure(result: ReturnType<typeof spawnSync>): string {
  if (result.error?.message) return result.error.message;
  const stderr = result.stderr?.toString().trim();
  if (stderr) return stderr;
  const stdout = result.stdout?.toString().trim();
  if (stdout) return stdout;
  return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { stdio: "pipe" });
  if (!result.error && result.status === 0) return null;
  return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
  const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
  if (failure) throw new Error(`Failed to extract ${assetName}: ${failure}`);
}

function getWindowsTarCommand(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot) {
    const systemTar = join(systemRoot, "System32", "tar.exe");
    if (existsSync(systemTar)) return systemTar;
  }
  return "tar.exe";
}

function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
  const failures: string[] = [];
  if (process.platform === "win32") {
    const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
    if (!tarFailure) return;
    failures.push(tarFailure);
    const script = "& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
    const powershellFailure = runExtractionCommand("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
      archivePath,
      extractDir,
    ]);
    if (!powershellFailure) return;
    failures.push(powershellFailure);
  } else {
    const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
    if (!unzipFailure) return;
    failures.push(unzipFailure);
    const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
    if (!tarFailure) return;
    failures.push(tarFailure);
  }
  throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

async function downloadTool(tool: SupportedTool): Promise<string> {
  const config = TOOLS[tool];
  if (!config) throw new Error(`Unknown tool: ${tool}`);
  const plat = process.platform;
  const architecture = process.arch;

  let version = await getLatestVersion(config.repo);
  if (tool === "fd" && plat === "darwin" && architecture === "x64") {
    version = "10.3.0";
  }

  const assetName = config.getAssetName(version, plat, architecture);
  if (!assetName) throw new Error(`Unsupported platform: ${plat}/${architecture}`);

  mkdirSync(TOOLS_DIR, { recursive: true });
  const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
  const archivePath = join(TOOLS_DIR, assetName);
  const binaryExt = plat === "win32" ? ".exe" : "";
  const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

  await downloadFile(downloadUrl, archivePath);

  const extractDir = join(
    TOOLS_DIR,
    `extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(extractDir, { recursive: true });
  try {
    if (assetName.endsWith(".tar.gz")) {
      extractTarGzArchive(archivePath, extractDir, assetName);
    } else if (assetName.endsWith(".zip")) {
      extractZipArchive(archivePath, extractDir, assetName);
    } else {
      throw new Error(`Unsupported archive format: ${assetName}`);
    }

    const binaryFileName = config.binaryName + binaryExt;
    const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
    const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
    let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));
    if (!extractedBinary) {
      extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
    }
    if (!extractedBinary) {
      throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
    }
    renameSync(extractedBinary, binaryPath);

    if (plat !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  } finally {
    rmSync(archivePath, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }
  return binaryPath;
}

const TERMUX_PACKAGES: Record<SupportedTool, string> = {
  fd: "fd",
  rg: "ripgrep",
};

/**
 * Ensure a tool is available, downloading it from GitHub if necessary.
 *
 * Returns the path to the tool, or `undefined` if it could not be obtained
 * (e.g. unsupported platform, offline mode, or download failure).
 */
export async function ensureTool(tool: SupportedTool, silent = false): Promise<string | undefined> {
  const existingPath = getToolPath(tool);
  if (existingPath) return existingPath;

  const config = TOOLS[tool];
  if (!config) return undefined;

  if (isOfflineModeEnabled()) {
    logWarn(silent, `${config.name} not found. Offline mode enabled, skipping download.`);
    return undefined;
  }

  // Termux ships fd/rg via `pkg`; prebuilt Linux binaries will not run.
  if (process.platform === "android") {
    const pkgName = TERMUX_PACKAGES[tool] ?? tool;
    logWarn(silent, `${config.name} not found. Install with: pkg install ${pkgName}`);
    return undefined;
  }

  logInfo(silent, `${config.name} not found. Downloading...`);
  try {
    const path = await downloadTool(tool);
    logInfo(silent, `${config.name} installed to ${path}`);
    return path;
  } catch (e) {
    logWarn(silent, `Failed to download ${config.name}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}
