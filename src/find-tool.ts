import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { createFindToolDefinition as createUpstreamFindToolDefinition } from "@earendil-works/pi-coding-agent";
import { Minimatch } from "minimatch";
import { ensureFdNoRequireGit, ensureTool } from "./internal/pi-coding-agent-utils.js";
import { resolveToCwd } from "./path-utils.js";
import { createGracefulTerminator } from "./process-termination.js";

const DEFAULT_LIMIT = 1000;

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function isInsideGitRepository(searchPath: string, signal?: AbortSignal): Promise<boolean> {
  let resolvedPath = searchPath;
  try {
    // fd follows a symlink passed as its search root; inspect the target's Git
    // ancestry too, while preserving the caller's path in the actual results.
    resolvedPath = await realpath(searchPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
  }
  for (let current = resolvedPath; ; current = path.dirname(current)) {
    if (signal?.aborted) throw new Error("Operation aborted");
    try {
      // .git may be a directory or a file (worktrees and submodules).
      await access(path.join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    }
    if (path.dirname(current) === current) return false;
  }
}

export function createFindToolDefinition(cwd: string): any {
  const template = createUpstreamFindToolDefinition(cwd);
  return {
    ...template,
    async execute(_toolCallId: string, { pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number }, signal?: AbortSignal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }

        let settled = false;
        let aborted = false;
        const settle = (fn: () => void, keepTermination = false) => {
          if (settled) return;
          settled = true;
          cleanup(keepTermination);
          fn();
        };
        let cleanup = (_keepTermination?: boolean) => {
          signal?.removeEventListener("abort", onAbort);
        };

        const onAbort = () => {
          aborted = true;
          terminator?.terminate();
          settle(() => reject(new Error("Operation aborted")), true);
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        let terminator: ReturnType<typeof createGracefulTerminator> | undefined;

        (async () => {
          try {
            const searchPath = resolveToCwd(searchDir || ".", cwd);
            const isWindows = process.platform === "win32";
            const glob = (isWindows && !path.isAbsolute(pattern) ? pattern.replaceAll("\\", "/") : pattern)
              .replace(/^(?:\.\/)+/, "");
            if (pattern && !glob) throw new Error("find pattern must contain a glob after './'. Specify the search directory in path.");
            const isPathGlob = glob.includes("/");
            const isRelativePathGlob = isPathGlob && !path.isAbsolute(glob);
            const ignoreCase = glob === glob.toLowerCase();
            // Older Windows fd releases do not match --full-path globs reliably. Keep
            // fd's traversal/ignore handling, and filter relative path globs as paths are emitted.
            const windowsMatcher = isWindows && isRelativePathGlob
              ? new Minimatch(glob.replace(/\/\*\*$/, "/**/*"), { dot: true, noext: true, nocase: ignoreCase, nonegate: true, nocomment: true })
              : undefined;
            // fd treats `--max-results 0` as unlimited and rejects negative or
            // fractional counts, so normalize before spawning: clamp below 1 to 1
            // and floor positive decimals. Ordinary positive integers pass through.
            const effectiveLimit = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
            let fdPath = await ensureTool("fd", true, signal);
            if (!fdPath) {
              settle(() => reject(new Error("fd is not available and could not be downloaded")));
              return;
            }
            const insideGit = await isInsideGitRepository(searchPath, signal);
            if (!insideGit) {
              // Omitting the flag on older fd would silently stop respecting
              // .gitignore outside Git repositories. Find a capable binary instead.
              fdPath = await ensureFdNoRequireGit(fdPath, signal);
              if (!fdPath) {
                settle(() => reject(new Error("fd with --no-require-git support (fd 8.7.0 or newer) is required to respect .gitignore outside Git repositories; install a newer fd or enable downloading")));
                return;
              }
            }
            if (signal?.aborted) {
              onAbort();
              return;
            }

            const args = ["--color=never", "--hidden"];
            if (!insideGit) args.push("--no-require-git");
            if (windowsMatcher) {
              args.push("--", "", searchPath);
            } else {
              args.push("--glob", "--max-results", String(effectiveLimit + 1));
              if (isPathGlob) args.push("--full-path");
              let fdPattern = glob;
              if (isRelativePathGlob) {
                // fd matches against absolute candidate paths. Escape the literal root and
                // decide smart case from the caller's glob, not the injected root.
                const escapedRoot = toPosixPath(searchPath).replace(/\/+$/, "").replace(/[\\*?[\]{}]/g, "\\$&");
                fdPattern = `${escapedRoot}/${glob}`;
                if (ignoreCase) args.push("--ignore-case");
              }
              args.push("--", fdPattern, searchPath);
            }

            const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
            terminator = createGracefulTerminator(child);
            const rl = createInterface({ input: child.stdout });
            const relativized: string[] = [];
            let stoppedAfterLookahead = false;
            let stderr = "";

            cleanup = (keepTermination = false) => {
              rl.close();
              signal?.removeEventListener("abort", onAbort);
              if (!keepTermination) terminator?.cleanup();
            };

            child.stderr?.on("data", (chunk) => {
              stderr += chunk.toString();
            });
            rl.on("line", (rawLine) => {
              if (stoppedAfterLookahead) return;
              const line = rawLine.replace(/\r$/, "");
              if (!line) return;
              // A textual prefix check fails at filesystem roots and for similar sibling names.
              let relativePath = toPosixPath(path.relative(searchPath, line));
              if (windowsMatcher && (!relativePath || path.isAbsolute(relativePath)
                || relativePath === ".." || relativePath.startsWith("../") || !windowsMatcher.match(relativePath))) return;
              if ((line.endsWith("/") || line.endsWith("\\")) && !relativePath.endsWith("/")) relativePath += "/";
              relativized.push(relativePath);
              if (windowsMatcher && relativized.length > effectiveLimit) {
                stoppedAfterLookahead = true;
                terminator?.terminate();
              }
            });
            child.on("error", (error) => {
              settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
            });
            child.on("close", (code, exitSignal) => {
              if (aborted) {
                terminator?.cleanup();
                settle(() => reject(new Error("Operation aborted")));
                return;
              }
              const stoppedByUs = stoppedAfterLookahead && (exitSignal === "SIGTERM" || exitSignal === "SIGKILL");
              if (code !== 0 && !stoppedByUs) {
                const exitCode = code ?? "unknown";
                const diagnostics = [
                  `Error: fd exited with code ${exitCode}.`,
                  `stderr: ${stderr.trim() || "(empty)"}`,
                ];
                if (relativized.length > 0) diagnostics.push("", "Partial output:", relativized.join("\n"));
                settle(() => resolve({
                  content: [{ type: "text" as const, text: diagnostics.join("\n") }],
                  details: {
                    exitCode: code,
                    ...(relativized.length > 0 ? { partialOutput: true } : {}),
                  },
                  isError: true,
                }));
                return;
              }
              if (relativized.length === 0) {
                settle(() => resolve({ content: [{ type: "text" as const, text: "No files found matching pattern" }], details: undefined }));
                return;
              }

              // Only the additional matching entry proves overflow. On Windows
              // the relative-glob fallback counts matches after filtering.
              const resultLimitReached = relativized.length > effectiveLimit;
              const outputLines = relativized.slice(0, effectiveLimit);
              let resultOutput = outputLines.join("\n");
              const details: Record<string, unknown> = {};
              const notices: string[] = [];
              if (resultLimitReached) {
                notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
                details.resultLimitReached = effectiveLimit;
              }
              if (notices.length > 0) resultOutput += `\n\n[${notices.join(". ")}]`;

              settle(() => resolve({
                content: [{ type: "text" as const, text: resultOutput }],
                details: Object.keys(details).length > 0 ? details : undefined,
              }));
            });
          } catch (error) {
            if (signal?.aborted) {
              onAbort();
              return;
            }
            settle(() => reject(error instanceof Error ? error : new Error(String(error))));
          }
        })();
      });
    },
  };
}
