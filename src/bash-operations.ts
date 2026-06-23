import { spawn } from "node:child_process";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { getShellEnv, trackDetachedChildPid, untrackDetachedChildPid, waitForChildProcess } from "./internal/pi-coding-agent-utils.js";
import { createGracefulTerminator } from "./process-termination.js";

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

export function createGracefulBashOperations(options?: { shellPath?: string }): BashOperations {
  return {
    exec: (command: string, cwd: string, { onData, signal, timeout, env }: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    }) =>
      new Promise<{ exitCode: number | null }>((resolve, reject) => {
        const { shell, args } = getShellConfig(options?.shellPath);
        const child = spawn(shell, [...args, command], {
          cwd,
          detached: process.platform !== "win32",
          env: env ?? getShellEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (child.pid) trackDetachedChildPid(child.pid);

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
          if (child.pid) untrackDetachedChildPid(child.pid);
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
            resolve({ exitCode: code });
          })
          .catch((error: Error) => {
            cleanup();
            reject(error);
          });
      }),
  };
}
