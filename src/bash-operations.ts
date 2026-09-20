import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { getShellEnv, waitForChildProcess } from "./internal/pi-coding-agent-utils.js";
import { createGracefulTerminator } from "./process-termination.js";
import { parseTimeoutSeconds } from "./timeout.js";

export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

/**
 * Pi 0.86's `BashOperations` contract treats a null exit code as a generic failed command and asks
 * executors to report signal terminations as `128 + signal number`. Mapping the signal here keeps
 * the signal identity in the reported status instead of collapsing it into that generic failure;
 * a signal without a known number still falls back to the generic failure code. Mirrors Pi's own
 * local shell operations.
 */
function resolveSignalExitCode(signalCode: NodeJS.Signals | null): number {
  const signalNumber = signalCode ? osConstants.signals[signalCode] : undefined;
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}

export function createGracefulBashOperations(options?: { shellPath?: string }): BashOperations {
  return {
    exec: (command: string, cwd: string, { onData, signal, timeout, env }: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    }) =>
      new Promise<{ exitCode: number }>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        if (timeout !== undefined) {
          try {
            timeout = parseTimeoutSeconds(timeout, "timeout", timeout);
          } catch (error) {
            reject(error);
            return;
          }
        }
        const shellConfig = getShellConfig(options?.shellPath);
        const commandFromStdin = shellConfig.commandTransport === "stdin";
        const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
          cwd,
          detached: process.platform !== "win32",
          env: env ?? getShellEnv(),
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        if (commandFromStdin) {
          child.stdin?.on("error", () => undefined);
          child.stdin?.end(command);
        }

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        const terminator = createGracefulTerminator(child, { killTree: true });

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            terminator.terminate();
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        const onAbort = () => terminator.terminate();
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        const cleanup = () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          terminator.cleanup();
        };

        waitForChildProcess(child)
          .then((code: number | null) => {
            cleanup();
            if (signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            if (timedOut) {
              reject(new Error(`timeout:${timeout}`));
              return;
            }
            resolve({ exitCode: code ?? resolveSignalExitCode(child.signalCode) });
          })
          .catch((error: Error) => {
            cleanup();
            reject(error);
          });
      }),
  };
}
