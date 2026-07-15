import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

export const DEFAULT_FORCE_KILL_AFTER_MS = 3_000;

export interface GracefulTerminationOptions {
  killTree?: boolean;
  forceKillAfterMs?: number;
}

export interface GracefulTerminator {
  terminate: () => void;
  forceTerminate: () => void;
  cleanup: () => void;
  isTerminating: () => boolean;
}

function spawnTaskkill(args: string[]) {
  try {
    const killer = spawn("taskkill", args, { stdio: "ignore", detached: true });
    killer.on("error", () => undefined);
    killer.unref();
  } catch {
    // Ignore failures while attempting best-effort termination.
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    child.kill(signal);
  } catch {
    // Ignore failures when the process already exited.
  }
}

function signalProcessTree(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function hasProcessTree(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function requestSoftTermination(child: ChildProcess, killTree: boolean) {
  if (process.platform === "win32") {
    if (killTree && typeof child.pid === "number") {
      spawnTaskkill(["/T", "/PID", String(child.pid)]);
      return;
    }
    signalChild(child, "SIGTERM");
    return;
  }
  if (killTree && typeof child.pid === "number" && signalProcessTree(child.pid, "SIGTERM")) return;
  signalChild(child, "SIGTERM");
}

function forceTermination(child: ChildProcess, killTree: boolean) {
  if (process.platform === "win32") {
    if (killTree && typeof child.pid === "number") {
      spawnTaskkill(["/F", "/T", "/PID", String(child.pid)]);
      return;
    }
    signalChild(child, "SIGKILL");
    return;
  }
  if (killTree && typeof child.pid === "number" && signalProcessTree(child.pid, "SIGKILL")) return;
  signalChild(child, "SIGKILL");
}

export function createGracefulTerminator(child: ChildProcess, options: GracefulTerminationOptions = {}): GracefulTerminator {
  const killTree = options.killTree === true;
  const forceKillAfterMs = options.forceKillAfterMs ?? DEFAULT_FORCE_KILL_AFTER_MS;
  let exited = false;
  let terminating = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const processTreePid = killTree && typeof child.pid === "number" ? child.pid : undefined;

  const clearForceKillTimer = () => {
    if (!forceKillTimer) return;
    clearTimeout(forceKillTimer);
    forceKillTimer = undefined;
  };

  const shouldKeepTreeEscalation = () => {
    if (!killTree || !terminating || !forceKillTimer) return false;
    if (processTreePid === undefined) return false;
    if (process.platform === "win32") return true;
    return hasProcessTree(processTreePid);
  };

  const forceNow = () => {
    clearForceKillTimer();
    if (!killTree) {
      if (exited) return;
    } else if (processTreePid === undefined) {
      if (exited) return;
    } else if (process.platform !== "win32" && !hasProcessTree(processTreePid)) {
      return;
    }
    forceTermination(child, killTree);
  };

  const markExited = () => {
    exited = true;
    if (!shouldKeepTreeEscalation()) clearForceKillTimer();
  };

  child.once("exit", markExited);
  child.once("close", markExited);

  return {
    terminate: () => {
      if (terminating || exited) return;
      terminating = true;
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        forceNow();
      }, forceKillAfterMs);
      requestSoftTermination(child, killTree);
    },
    forceTerminate: () => {
      terminating = true;
      forceNow();
    },
    cleanup: () => {
      if (!shouldKeepTreeEscalation()) clearForceKillTimer();
      child.removeListener("exit", markExited);
      child.removeListener("close", markExited);
    },
    isTerminating: () => terminating,
  };
}
