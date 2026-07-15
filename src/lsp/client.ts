import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { decodeTextFile } from "../text-codec.js";
import { createGracefulTerminator, type GracefulTerminator } from "../process-termination.js";
import { findBestJavaHome, LspDiscoveryResolver, type LspServerConfig, type LspWorkspaceDataConfig } from "./discovery.js";

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".java": "java",
  ".go": "go",
  ".py": "python",
  ".pyi": "python",
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".h": "c",
  ".hpp": "cpp",
};

const MAX_INIT_RETRIES = 3;
const INIT_RETRY_DELAY_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1000;
const FORCE_KILL_WAIT_MS = 1000;
const NOOP = () => undefined;

function readLspTextFile(filePath: string): string {
  const decoded = decodeTextFile(readFileSync(filePath));
  if (decoded === null) throw new Error(`LSP cannot open binary file: ${filePath}`);
  return decoded.text;
}

function isJdtlsCommand(command: string[]): boolean {
  return command.some((part) => dirname(part) ? part.split(/[\\/]/).pop()?.toLowerCase().replace(/\.(cmd|bat|exe)$/i, "") === "jdtls" : part.toLowerCase().replace(/\.(cmd|bat|exe)$/i, "") === "jdtls");
}

/**
 * Probe for `lombok.jar` in common locations. We only look in places jdtls
 * users actually tend to install it; we never add implicit search paths.
 */
function findLombokJar(): string | null {
  const candidates = [
    join(homedir(), ".local", "share", "nvim", "mason", "packages", "jdtls", "lombok.jar"),
    join(homedir(), ".local", "share", "eclipse", "lombok.jar"),
    join(homedir(), "jdtls", "lombok.jar"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Estimate JVM heap for jdtls by counting .java files (capped). Heuristic only.
 * Falls back to 1g on any error.
 */
function estimateJdtlsHeapSize(root: string): string {
  const SKIP_DIRS = new Set(["node_modules", "target", "build", ".git", ".gradle", ".idea", "bin", "out"]);
  try {
    let count = 0;
    const max = 2000;
    const countWalk = (dir: string, depth: number): void => {
      if (depth > 15 || count >= max) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (count >= max) return;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) countWalk(join(dir, entry.name), depth + 1);
        } else if (entry.isFile() && entry.name.endsWith(".java")) {
          count++;
        }
      }
    };
    countWalk(root, 0);
    if (count < 100) return "1g";
    if (count < 1000) return "2g";
    if (count < 2000) return "3g";
    return "4g";
  } catch {
    return "1g";
  }
}

export function buildJdtlsWorkspaceDataDir(root: string, config: LspWorkspaceDataConfig | undefined): string | null {
  const mode = config?.mode ?? "stable";
  if (mode === "disabled") return null;
  const hash = createHash("md5").update(root).digest("hex");
  const suffix = mode === "process" ? `${hash}-${process.pid}` : hash;
  return join(config?.baseDir ?? join(homedir(), ".cache", "jdtls-workspace"), suffix);
}

function enhanceJdtlsCommand(command: string[], root: string, workspaceData?: LspWorkspaceDataConfig): string[] {
  if (!isJdtlsCommand(command)) return command;
  const updated = [...command];
  const lombok = findLombokJar();
  if (lombok && !updated.some((arg) => arg.includes("lombok.jar"))) {
    updated.push(`--jvm-arg=-javaagent:${lombok}`);
  }
  if (!updated.includes("-data")) {
    const dataDir = buildJdtlsWorkspaceDataDir(root, workspaceData);
    if (dataDir) updated.push("-data", dataDir);
  }
  if (!updated.some((arg) => arg.startsWith("--jvm-arg=-Xmx") || arg.startsWith("-Xmx"))) {
    updated.push(`--jvm-arg=-Xmx${estimateJdtlsHeapSize(root)}`);
  }
  return updated;
}

function enhanceJdtlsEnv(command: string[], baseEnv: NodeJS.ProcessEnv | undefined): Record<string, string> {
  if (!isJdtlsCommand(command)) return {};
  const javaHome = findBestJavaHome();
  if (!javaHome) return {};
  const pathSep = process.platform === "win32" ? ";" : ":";
  return {
    JAVA_HOME: javaHome,
    PATH: `${join(javaHome, "bin")}${pathSep}${baseEnv?.PATH ?? ""}`,
  };
}

type PendingHandler = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type DiagnosticsWaiter = { resolve: (diagnostics: unknown[]) => void; reject: (error: Error) => void };

function abortError(): Error {
  return new Error("Operation aborted");
}

async function waitForGracefulShutdown(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForProcessExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null) return true;
  if (timeoutMs <= 0) return false;
  const eventProc = proc as ChildProcessWithoutNullStreams & {
    once?: (event: "exit" | "error", listener: () => void) => unknown;
    removeListener?: (event: "exit" | "error", listener: () => void) => unknown;
  };
  if (typeof eventProc.once !== "function") return false;

  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean) => {
      if (timer) clearTimeout(timer);
      eventProc.removeListener?.("exit", onExit);
      eventProc.removeListener?.("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(proc.exitCode !== null);
    eventProc.once?.("exit", onExit);
    eventProc.once?.("error", onError);
    if (proc.exitCode !== null) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(proc.exitCode !== null), timeoutMs);
  });
}

async function forceTerminateProcess(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null) return;
  const eventProc = proc as ChildProcessWithoutNullStreams & {
    once?: (event: "exit" | "error", listener: () => void) => unknown;
    removeListener?: (event: "exit" | "error", listener: () => void) => unknown;
  };
  if (typeof eventProc.once !== "function") {
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    return;
  }

  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      eventProc.removeListener?.("exit", finish);
      eventProc.removeListener?.("error", finish);
      resolve();
    };
    eventProc.once?.("exit", finish);
    eventProc.once?.("error", finish);
    if (proc.exitCode !== null) {
      finish();
      return;
    }
    timer = setTimeout(finish, FORCE_KILL_WAIT_MS);
    try {
      proc.kill("SIGKILL");
    } catch {
      finish();
    }
  });
}

function isTransientPullDiagnosticsInternalError(error: (Error & { code?: number }) | null | undefined): boolean {
  return error?.code == null && error?.message === "Internal error";
}

function formatTransientDiagnosticsTimeoutError(serverId: string, filePath: string): string {
  return `LSP server '${serverId}' returned "Internal error" for ${filePath} and did not publish diagnostics before the timeout. This often means the server has not finished opening the file or processing the workspace yet (common on the first call or after opening a large project). Retry in a few seconds. If the error persists, inspect the server logs or increase lsp.servers.${serverId}.requestTimeoutMs in ~/.pi/agent/pi-base.json, then run /reload for the change to take effect.`;
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private terminator: GracefulTerminator | null = null;
  private transportFailure: Error | null = null;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, PendingHandler>();
  private requestId = 0;
  private openedFiles = new Set<string>();
  private fileVersions = new Map<string, number>();
  private fileMtimes = new Map<string, number>();
  private fileContents = new Map<string, string>();
  private diagnosticsStore = new Map<string, unknown[]>();
  private diagnosticsWaiters = new Map<string, DiagnosticsWaiter[]>();
  private positionEncoding: "utf-8" | "utf-16" | "utf-32" = "utf-16";
  private serverCapabilities: Record<string, unknown> = {};
  private requestTimeoutMs: number;
  private readonly onActivity: () => void;
  private publishedDiagnosticsWarm = false;
  private coldStartDiagnosticsQueueTail: Promise<void> = Promise.resolve();
  private stopping = false;
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly root: string, private readonly server: LspServerConfig, options: { onActivity?: () => void } = {}) {
    this.requestTimeoutMs = server.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onActivity = options.onActivity ?? NOOP;
  }

  async start(): Promise<void> {
    if (this.stopping) throw new Error("LSP client stopped");
    this.transportFailure = null;
    const jdtlsEnhancedCommand = isJdtlsCommand(this.server.command) ? enhanceJdtlsCommand(this.server.command, this.root, this.server.workspaceData) : this.server.command;
    const jdtlsEnv = enhanceJdtlsEnv(jdtlsEnhancedCommand, process.env);
    this.proc = spawn(jdtlsEnhancedCommand[0], jdtlsEnhancedCommand.slice(1), {
      cwd: this.root,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...jdtlsEnv },
    });
    this.terminator = createGracefulTerminator(this.proc, { killTree: true });
    this.proc.on("error", (err) => {
      this.recordTransportFailure(`LSP server failed to start: ${err.message}`);
    });
    this.proc.on("exit", (code) => {
      this.recordTransportFailure(`LSP server exited (code: ${code ?? "null"})`);
    });
    this.proc.stdout.on("data", (chunk) => this.onData(chunk as Buffer));
    this.proc.stdin.on("error", (err) => this.recordTransportFailure(`LSP stdin error: ${err.message}`));
    this.proc.stdout.on("error", (err) => this.recordTransportFailure(`LSP stdout error: ${err.message}`));
    this.proc.stderr.on("data", () => undefined);
    this.proc.stderr.on("error", (err) => this.recordTransportFailure(`LSP stderr error: ${err.message}`));
    // Wait briefly for the process to either die (e.g. missing binary) or survive.
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (this.stopping || !this.proc) throw new Error("LSP client stopped");
    if (this.proc.exitCode !== null || this.proc.killed) {
      const detail = this.proc.exitCode === null ? "killed before start" : `exited with code ${this.proc.exitCode}`;
      throw new Error(`LSP server '${this.server.command.join(" ")}' ${detail} for ${this.root}. Check that the server is installed and reachable on PATH.`);
    }
    const transportFailure = this.transportFailure as Error | null;
    if (transportFailure) throw new Error(transportFailure.message);
  }

  async initialize(): Promise<void> {
    const rootUri = pathToFileURL(this.root).href;
    const workspaceFolders = this.workspaceFolders();
    const initParams: Record<string, unknown> = {
      processId: process.pid,
      rootUri,
      rootPath: this.root,
      workspaceFolders,
      capabilities: {
        general: { positionEncodings: ["utf-32", "utf-16", "utf-8"] },
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
        },
        workspace: { workspaceFolders: true },
      },
    };
    if (isJdtlsCommand(this.server.command)) {
      initParams.initializationOptions = {
        extendedClientCapabilities: {
          classFileContentsSupport: true,
          generateToStringPromptSupport: true,
          hashCodeEqualsPromptSupport: true,
          advancedExtractRefactoringSupport: true,
          advancedOrganizeImportsSupport: true,
        },
      };
    }
    let result: any = null;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_INIT_RETRIES; attempt++) {
      if (this.stopping) throw new Error("LSP client stopped");
      try {
        result = await this.send("initialize", initParams);
        lastError = null;
        break;
      } catch (error) {
        if (this.stopping) throw error;
        lastError = error as Error;
        await new Promise((resolve) => setTimeout(resolve, INIT_RETRY_DELAY_MS));
      }
    }
    if (lastError) throw new Error(`LSP initialize failed for ${this.server.command.join(" ")}: ${lastError.message}`);
    if (result?.capabilities?.positionEncoding) this.positionEncoding = result.capabilities.positionEncoding;
    this.serverCapabilities = (result?.capabilities ?? {}) as Record<string, unknown>;
    this.notify("initialized", {});
  }

  isJdtls(): boolean {
    return isJdtlsCommand(this.server.command);
  }
  prefersPublishedDiagnostics(): boolean {
    return this.isJdtls();
  }
  serializesColdStartDiagnostics(): boolean {
    return this.isJdtls();
  }

  /** Server id from the discovery config (e.g. "jdtls", "typescript-language-server"). */
  serverId(): string {
    return this.server.id;
  }

  /**
   * Check whether the LSP server advertised support for a given JSON-RPC method.
   * Used to short-circuit unsupported capabilities with a clear error message
   * instead of letting the server return a generic `-32601 Method Not Found`.
   */
  supportsMethod(method: string): boolean {
    const cap = this.serverCapabilities;
    switch (method) {
      case "workspace/symbol":
        return cap.workspaceSymbolProvider === true || typeof cap.workspaceSymbolProvider === "object";
      case "textDocument/definition":
        return cap.definitionProvider === true || typeof cap.definitionProvider === "object";
      case "textDocument/publishDiagnostics":
        // Don't pre-check: many servers (including jdtls) push diagnostics in
        // practice even when their advertised capability is missing or uses a
        // non-standard field. If a server truly doesn't support diagnostics,
        // the configured request timeout will surface that gracefully.
        return true;
      case "java/classFileContents":
        // jdtls-specific extension; only valid when running jdtls and it advertised support.
        return this.isJdtls();
      default:
        return true;
    }
  }

  isOpen(filePath: string): boolean {
    return this.openedFiles.has(resolve(filePath));
  }

  isAlive(): boolean {
    return this.transportFailure === null && this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  syncExternalChanges(): void {
    for (const filePath of this.openedFiles) {
      try {
        const current = statSync(filePath).mtimeMs;
        if (this.fileMtimes.get(filePath) !== current) this.syncFile(filePath);
      } catch {
        this.closeFile(filePath);
      }
    }
  }

  async openFile(filePath: string): Promise<void> {
    const absPath = resolve(filePath);
    if (this.openedFiles.has(absPath)) return;
    const text = readLspTextFile(absPath);
    const languageId = EXT_TO_LANG[extname(absPath)] || "plaintext";
    this.fileVersions.set(absPath, 1);
    this.fileMtimes.set(absPath, statSync(absPath).mtimeMs);
    this.fileContents.set(absPath, text);
    this.diagnosticsStore.delete(pathToFileURL(absPath).href);
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(absPath).href,
        languageId,
        version: 1,
        text,
      },
    });
    this.openedFiles.add(absPath);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  syncFile(filePath: string): void {
    const absPath = resolve(filePath);
    if (!this.openedFiles.has(absPath)) return;
    const text = readLspTextFile(absPath);
    const version = (this.fileVersions.get(absPath) || 1) + 1;
    this.fileVersions.set(absPath, version);
    this.fileMtimes.set(absPath, statSync(absPath).mtimeMs);
    this.fileContents.set(absPath, text);
    const uri = pathToFileURL(absPath).href;
    this.diagnosticsStore.delete(uri);
    this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    this.notify("textDocument/didSave", { textDocument: { uri } });
  }

  closeFile(filePath: string): void {
    const absPath = resolve(filePath);
    const uri = pathToFileURL(absPath).href;
    try {
      if (this.openedFiles.has(absPath)) {
        this.notify("textDocument/didClose", { textDocument: { uri } });
      }
    } finally {
      this.openedFiles.delete(absPath);
      this.fileVersions.delete(absPath);
      this.fileMtimes.delete(absPath);
      this.fileContents.delete(absPath);
      this.diagnosticsStore.delete(uri);
      const waiters = this.diagnosticsWaiters.get(uri) ?? [];
      this.diagnosticsWaiters.delete(uri);
      for (const waiter of waiters) waiter.reject(new Error(`LSP file closed: ${absPath}`));
    }
  }

  async diagnostics(filePath: string, signal?: AbortSignal): Promise<unknown[]> {
    const absPath = resolve(filePath);
    const uri = pathToFileURL(absPath).href;
    return this.withSerializedColdStartDiagnostics(async () => {
      await this.openFile(absPath);
      if (this.prefersPublishedDiagnostics()) {
        const diagnostics = await this.waitForPublishedDiagnostics(uri, this.requestTimeoutMs, signal);
        this.publishedDiagnosticsWarm = true;
        return diagnostics;
      }
      let firstError: (Error & { code?: number }) | null = null;
      try {
        const result = (await this.send("textDocument/diagnostic", { textDocument: { uri } }, signal)) as any;
        if (result && Array.isArray(result.items)) return result.items;
      } catch (error) {
        // JSON-RPC -32601 = Method Not Found. The server may still push
        // diagnostics via publishDiagnostics even when it does not implement
        // textDocument/diagnostic.
        // Some LSP servers return a transient untyped "Internal error" on the
        // first pull of a freshly-opened workspace/file but then publish the same
        // diagnostics within seconds. Fall through to the push-wait only in that
        // narrow case so we don't fail fast on startup races or mask real
        // server-side failures such as JSON-RPC -32603 Internal Error.
        firstError = error as Error & { code?: number };
        const shouldWaitForPublishedDiagnostics =
          firstError.code === -32601 || isTransientPullDiagnosticsInternalError(firstError);
        if (!shouldWaitForPublishedDiagnostics) throw firstError;
      }
      try {
        return await this.waitForPublishedDiagnostics(uri, this.requestTimeoutMs, signal);
      } catch (error) {
        if (isTransientPullDiagnosticsInternalError(firstError) && error instanceof Error && error.message.startsWith("LSP diagnostics timeout after ")) {
          throw new Error(formatTransientDiagnosticsTimeoutError(this.server.id, absPath));
        }
        throw error;
      }
    }, signal);
  }

  async definition(filePath: string, line: number, character: number, signal?: AbortSignal): Promise<unknown> {
    const absPath = resolve(filePath);
    await this.openFile(absPath);
    return this.send("textDocument/definition", { textDocument: { uri: pathToFileURL(absPath).href }, position: { line: line - 1, character: this.toEncodedCharacter(absPath, line - 1, character) } }, signal);
  }

  async workspaceSymbols(query: string, signal?: AbortSignal): Promise<unknown> {
    return this.send("workspace/symbol", { query }, signal);
  }

  async classFileContents(uri: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.send("java/classFileContents", { uri }, signal);
    return typeof result === "string" ? result : null;
  }

  async decompileClass(uri: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.send("workspace/executeCommand", { command: "java.decompile", arguments: [uri] }, signal);
    return typeof result === "string" ? result : null;
  }

  stop(options: { shutdownGraceMs?: number } = {}): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = this.stopImpl(options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
    }
    return this.stopPromise;
  }

  private async stopImpl(shutdownGraceMs: number): Promise<void> {
    const proc = this.proc;
    const terminator = this.terminator;
    const gracefulDeadline = Date.now() + Math.max(0, shutdownGraceMs);
    this.stopping = true;
    this.rejectAllPending("LSP client stopped");
    this.rejectAllDiagnosticsWaiters("LSP client stopped");

    if (proc && proc.exitCode === null && !proc.killed) {
      try {
        await waitForGracefulShutdown(this.send("shutdown", null), Math.max(0, gracefulDeadline - Date.now()));
      } catch {
        // Best-effort graceful shutdown. The process is force-killed below.
      }
      try {
        this.notify("exit", {});
      } catch {
        // best-effort
      }
      await waitForProcessExit(proc, Math.max(0, gracefulDeadline - Date.now()));
    }

    if (proc && terminator) {
      terminator.forceTerminate();
      await waitForProcessExit(proc, FORCE_KILL_WAIT_MS);
      terminator.cleanup();
    } else if (proc) {
      await forceTerminateProcess(proc);
    }
    this.proc = null;
    this.terminator = null;
    this.openedFiles.clear();
    this.fileVersions.clear();
    this.fileMtimes.clear();
    this.fileContents.clear();
    this.diagnosticsStore.clear();
    this.rejectAllPending("LSP client stopped");
    this.rejectAllDiagnosticsWaiters("LSP client stopped");
    this.publishedDiagnosticsWarm = false;
    this.coldStartDiagnosticsQueueTail = Promise.resolve();
  }

  private toEncodedCharacter(filePath: string, line: number, codePointOffset: number): number {
    const content = this.fileContents.get(filePath);
    if (!content || this.positionEncoding === "utf-32") return codePointOffset;
    const lineText = content.split("\n")[line] ?? "";
    const prefix = Array.from(lineText).slice(0, codePointOffset).join("");
    if (this.positionEncoding === "utf-8") return Buffer.byteLength(prefix, "utf8");
    let utf16 = 0;
    for (const char of prefix) utf16 += (char.codePointAt(0) || 0) > 0xffff ? 2 : 1;
    return utf16;
  }

  private async withSerializedColdStartDiagnostics<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.serializesColdStartDiagnostics() || this.publishedDiagnosticsWarm) return task();
    const previous = this.coldStartDiagnosticsQueueTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.coldStartDiagnosticsQueueTail = previous.then(() => current, () => current);
    try {
      await this.waitForColdStartDiagnosticsTurn(previous, signal);
    } catch (error) {
      release();
      throw error;
    }
    try {
      return await task();
    } finally {
      release();
    }
  }

  private waitForColdStartDiagnosticsTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      previous.then(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      );
    });
  }
  private waitForPublishedDiagnostics(uri: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown[]> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.diagnosticsStore.has(uri)) return Promise.resolve(this.diagnosticsStore.get(uri) ?? []);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let waiter: DiagnosticsWaiter;
      const removeWaiter = () => {
        const waiters = this.diagnosticsWaiters.get(uri) ?? [];
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        if (waiters.length === 0) this.diagnosticsWaiters.delete(uri);
        else this.diagnosticsWaiters.set(uri, waiters);
      };
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        removeWaiter();
        reject(error);
      };
      const finish = (diagnostics: unknown[]) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        removeWaiter();
        resolve(diagnostics);
      };
      waiter = { resolve: finish, reject: finishReject };
      const list = this.diagnosticsWaiters.get(uri) ?? [];
      list.push(waiter);
      this.diagnosticsWaiters.set(uri, list);
      const onAbort = () => {
        finishReject(abortError());
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        if (settled) return;
        if (this.diagnosticsStore.has(uri)) {
          finish(this.diagnosticsStore.get(uri) ?? []);
          return;
        }
        finishReject(new Error(`LSP diagnostics timeout after ${timeoutMs}ms. The server did not return diagnostics for this file. Increase lsp.servers.${this.server.id}.requestTimeoutMs if this server is legitimately slow, then run /reload for the change to take effect.`));
      }, timeoutMs);
    });
  }

  private notify(method: string, params: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private send(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.stopping && method !== "shutdown") throw new Error("LSP client stopped");
    if (this.transportFailure) throw new Error(this.transportFailure.message);
    if (!this.proc || this.proc.exitCode !== null || this.proc.killed) throw new Error("LSP client not started");
    if (signal?.aborted) throw abortError();
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`LSP request timeout (${method}) after ${this.requestTimeoutMs}ms. Increase lsp.servers.${this.server.id}.requestTimeoutMs if this server is legitimately slow, then run /reload for the change to take effect.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          this.onActivity();
          resolve(value);
        },
        reject: (error) => {
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          this.onActivity();
          reject(error);
        },
        timer,
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        this.writeMessage({ jsonrpc: "2.0", id, method, params });
        this.onActivity();
      } catch (error) {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private workspaceFolders(): Array<{ uri: string; name: string }> {
    return [{ uri: pathToFileURL(this.root).href, name: "workspace" }];
  }

  private writeMessage(payload: unknown): void {
    if (this.transportFailure) throw new Error(this.transportFailure.message);
    if (!this.proc || this.proc.exitCode !== null || this.proc.killed) return;
    const message = JSON.stringify(payload);
    try {
      this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = `LSP stdin error: ${message}`;
      this.recordTransportFailure(reason);
      throw new Error(reason);
    }
  }

  private recordTransportFailure(reason: string): void {
    if (!this.transportFailure) this.transportFailure = new Error(reason);
    this.rejectAllPending(this.transportFailure.message);
    this.rejectAllDiagnosticsWaiters(this.transportFailure.message);
  }

  private respondToServerRequest(id: unknown, method: string): void {
    if (method === "workspace/workspaceFolders") {
      this.writeMessage({ jsonrpc: "2.0", id, result: this.workspaceFolders() });
      return;
    }
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  private onData(chunk: Buffer): void {
    this.onActivity();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        // Discard one malformed header block so stray server stdout cannot pin the parser forever.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const start = headerEnd + 4;
      const end = start + length;
      if (this.buffer.length < end) return;
      const payload = this.buffer.subarray(start, end).toString("utf8");
      this.buffer = this.buffer.subarray(end);
      try {
        const message = JSON.parse(payload);
        if (message.method === "textDocument/publishDiagnostics" && message.params?.uri) {
          const diagnostics = message.params.diagnostics ?? [];
          this.publishedDiagnosticsWarm = true;
          this.diagnosticsStore.set(message.params.uri, diagnostics);
          const waiters = this.diagnosticsWaiters.get(message.params.uri) ?? [];
          this.diagnosticsWaiters.delete(message.params.uri);
          for (const waiter of waiters) waiter.resolve(diagnostics);
          continue;
        }
        if (typeof message.method === "string" && typeof message.id !== "undefined") {
          this.respondToServerRequest(message.id, message.method);
          continue;
        }
        if (typeof message.id !== "undefined") {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) {
            const err = new Error(message.error.message);
            if (typeof message.error.code === "number") (err as Error & { code?: number }).code = message.error.code;
            pending.reject(err);
          } else {
            pending.resolve(message.result);
          }
        }
      } catch {
        // ignore malformed server messages
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, handler] of this.pending) {
      clearTimeout(handler.timer);
      handler.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private rejectAllDiagnosticsWaiters(reason: string): void {
    const waiters = Array.from(this.diagnosticsWaiters.values()).flat();
    this.diagnosticsWaiters.clear();
    for (const waiter of waiters) {
      waiter.reject(new Error(reason));
    }
  }
}

interface PendingLspClient {
  client: LspClient;
  promise: Promise<LspClient>;
}

export class LspManager {
  private clients = new Map<string, LspClient>();
  private pendingClients = new Map<string, PendingLspClient>();
  // Prevent a same-workspace replacement from starting before idle eviction finishes shutdown.
  private retiringClients = new Map<string, Promise<void>>();
  private generation = 0;
  /**
   * Per-key timestamp of the last observed activity. "Activity" means:
   *   - `getClient` returned a live client for this key;
   *   - the client called its `onActivity` callback (i.e. it sent or
   *     received a JSON-RPC message, or saw server-side traffic).
   * Used to evict clients that have been idle for `idleTimeoutMs`.
   */
  private lastUsedAt = new Map<string, number>();
  /**
   * Single-shot timer for the next idle-eviction check. We deliberately do
   * not use `setInterval`: activity updates `lastUsedAt`, and the pending check
   * either evicts an idle client or re-arms itself for the updated deadline.
   * Tests using `vi.useFakeTimers()` only ever have to clear one handle. A
   * quiet manager (no LSP calls) never arms the timer, so the cost is zero.
   */
  private idleCheckTimer: NodeJS.Timeout | null = null;
  private readonly idleTimeoutMs: number;
  private readonly shutdownGraceMs: number;

  constructor(options: { idleTimeoutMs?: number; shutdownGraceMs?: number } = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  }

  /**
   * Get or create a client for `filePath` using the supplied resolver.
   *
   * The resolver is the only source of truth for which server to launch and
   * which workspace root to use. Callers should pass a resolver built from
   * the current request's `ctx.cwd` so that switching projects never reuses
   * a previous project's server table.
   */
  async getClient(filePath: string, resolver: LspDiscoveryResolver): Promise<LspClient> {
    const server = resolver.findServerForFile(filePath);
    const root = resolver.findWorkspaceRoot(filePath, server);
    const key = `${root}::${server.id}`;
    const generation = this.generation;
    const retirement = this.retiringClients.get(key);
    if (retirement) await retirement;
    this.noteActivity(key);
    let client = this.clients.get(key);
    if (!client || !client.isAlive()) {
      const pending = this.pendingClients.get(key);
      if (pending) {
        client = await pending.promise;
      } else {
        const staleClient = client;
        const nextClient = new LspClient(root, server, {
          onActivity: () => this.noteActivity(key),
        });
        let boot!: Promise<LspClient>;
        boot = (async () => {
          if (staleClient) {
            // Drop the dead/being-replaced client from the maps BEFORE
            // we attempt the new boot, so a failed new boot does not
            // leave a stale entry that the next idle check would
            // otherwise have to clean up.
            this.clients.delete(key);
            this.lastUsedAt.delete(key);
            await staleClient.stop({ shutdownGraceMs: this.shutdownGraceMs }).catch(() => undefined);
          }
          try {
            if (generation !== this.generation) throw new Error("LSP client startup cancelled");
            await nextClient.start();
            await nextClient.initialize();
            if (generation !== this.generation) throw new Error("LSP client startup cancelled");
            this.clients.set(key, nextClient);
            return nextClient;
          } catch (error) {
            await nextClient.stop({ shutdownGraceMs: this.shutdownGraceMs }).catch(() => undefined);
            throw error;
          } finally {
            if (this.pendingClients.get(key)?.promise === boot) this.pendingClients.delete(key);
            this.noteActivity(key);
          }
        })();
        this.pendingClients.set(key, { client: nextClient, promise: boot });
        client = await boot;
      }
    }
    client.syncExternalChanges();
    return client;
  }

  /**
   * Mark `key` as just-used and (if no check is pending) arm the timer.
   *
   * Guards on `this.clients.has(key)` so that:
   *   - a late response from a killed client (the response wrapper calls
   *     `onActivity` after we already evicted the entry) does not leave
   *     a stale timestamp in `lastUsedAt` that would skew the next
   *     re-arm;
   *   - a `getClient` call whose boot has not yet completed cannot
   *     promote a "phantom" timestamp that would let the idle check
   *     see the key before `clients.set` is reached.
   * The boot's `finally` block is the one place that legitimately
   * records activity for a freshly-added client.
   */
  private noteActivity(key: string): void {
    if (!this.clients.has(key)) return;
    this.lastUsedAt.set(key, Date.now());
    this.scheduleIdleCheck();
  }

  /**
   * Arm the eviction timer if it isn't already. Activity does not replace an
   * existing timer; when that check fires, it uses the latest timestamps and
   * re-arms for the earliest remaining deadline.
   */
  private scheduleIdleCheck(): void {
    if (this.idleCheckTimer) return;
    this.idleCheckTimer = setTimeout(() => this.runIdleCheck(), this.idleTimeoutMs);
  }

  /**
   * Walk the client pool, evict anything past its deadline, and re-arm
   * the timer for whatever is still alive. Called exactly once per timer
   * fire; the timer is nulled out at the top so concurrent activity can
   * immediately schedule a fresh check.
   */
  private runIdleCheck(): void {
    this.idleCheckTimer = null;
    const now = Date.now();
    for (const [key, client] of this.clients) {
      // Don't kill a client whose boot is still in flight; the boot's
      // `finally` block will re-arm the timer once it lands.
      if (this.pendingClients.has(key)) continue;
      const lastUsed = this.lastUsedAt.get(key);
      // `lastUsedAt` may be momentarily missing for a freshly-added
      // client: `clients.set(key, nextClient)` runs *before* the
      // boot's `finally` calls `noteActivity`. Treating that as
      // "dead since time 0" would kill a client that just booted,
      // so we skip it and let the `finally` re-arm the timer.
      if (lastUsed === undefined) continue;
      if (now - lastUsed >= this.idleTimeoutMs) {
        const retirement = client.stop({ shutdownGraceMs: this.shutdownGraceMs }).catch(() => undefined);
        this.retiringClients.set(key, retirement);
        void retirement.finally(() => {
          if (this.retiringClients.get(key) === retirement) this.retiringClients.delete(key);
        });
        this.clients.delete(key);
        this.lastUsedAt.delete(key);
      }
    }
    // Re-arm based on the *remaining* clients' `lastUsedAt`. Iterating
    // `this.clients.keys()` (rather than `lastUsedAt.values()`) keeps a
    // stale timestamp from a key that was already evicted from
    // influencing the next deadline.
    if (this.clients.size > 0) {
      let earliest = Number.POSITIVE_INFINITY;
      for (const key of this.clients.keys()) {
        const t = this.lastUsedAt.get(key);
        if (t !== undefined && t < earliest) earliest = t;
      }
      if (earliest !== Number.POSITIVE_INFINITY) {
        const delay = Math.max(0, earliest + this.idleTimeoutMs - now);
        this.idleCheckTimer = setTimeout(() => this.runIdleCheck(), delay);
      }
    }
  }

  async syncFileIfOpen(filePath: string): Promise<void> {
    for (const client of this.clients.values()) {
      if (client.isAlive() && client.isOpen(filePath)) client.syncFile(filePath);
    }
  }

  async closeFileIfOpen(filePath: string): Promise<void> {
    for (const client of this.clients.values()) {
      if (client.isAlive() && client.isOpen(filePath)) client.closeFile(filePath);
    }
  }

  async shutdownAll(): Promise<void> {
    this.generation++;
    if (this.idleCheckTimer) {
      clearTimeout(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }

    const clients = new Set<LspClient>([
      ...this.clients.values(),
      ...Array.from(this.pendingClients.values(), (pending) => pending.client),
    ]);
    const retirements = [...this.retiringClients.values()];
    this.clients.clear();
    this.pendingClients.clear();
    this.retiringClients.clear();
    this.lastUsedAt.clear();
    await Promise.all([
      ...Array.from(clients, (client) => client.stop({ shutdownGraceMs: this.shutdownGraceMs }).catch(() => undefined)),
      ...retirements,
    ]);
  }
}

export const lspManager = new LspManager();
