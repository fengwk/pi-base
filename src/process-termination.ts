import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

export const DEFAULT_FORCE_KILL_AFTER_MS = 3_000;

export interface GracefulTerminationOptions {
  killTree?: boolean;
  forceKillAfterMs?: number;
}

export interface GracefulTerminator {
  terminate: () => void;
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

function requestSoftTermination(child: ChildProcess, killTree: boolean) {
  if (process.platform === "win32") {
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

  const markExited = () => {
    exited = true;
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
  };

  child.once("exit", markExited);
  child.once("close", markExited);

  return {
    terminate: () => {
      if (terminating || exited) return;
      terminating = true;
      requestSoftTermination(child, killTree);
      forceKillTimer = setTimeout(() => {
        if (exited) return;
        forceTermination(child, killTree);
      }, forceKillAfterMs);
    },
    cleanup: () => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
      child.removeListener("exit", markExited);
      child.removeListener("close", markExited);
    },
    isTerminating: () => terminating,
  };
}
