import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { createFindToolDefinition as createUpstreamFindToolDefinition } from "@earendil-works/pi-coding-agent";
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

            const args = ["--glob", "--color=never", "--hidden", "--max-results", String(effectiveLimit + 1)];
            if (!insideGit) args.push("--no-require-git");
            let effectivePattern = pattern;
            if (pattern.includes("/")) {
              args.push("--full-path");
              if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
                effectivePattern = `**/${pattern}`;
              }
            }
            args.push("--", effectivePattern, searchPath);

            const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
            terminator = createGracefulTerminator(child);
            const rl = createInterface({ input: child.stdout });
            const lines: string[] = [];
            let stderr = "";

            cleanup = (keepTermination = false) => {
              rl.close();
              signal?.removeEventListener("abort", onAbort);
              if (!keepTermination) terminator?.cleanup();
            };

            child.stderr?.on("data", (chunk) => {
              stderr += chunk.toString();
            });
            rl.on("line", (line) => {
              lines.push(line);
            });
            child.on("error", (error) => {
              settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
            });
            child.on("close", (code) => {
              if (aborted) {
                terminator?.cleanup();
                settle(() => reject(new Error("Operation aborted")));
                return;
              }
              const output = lines.join("\n");
              const relativized: string[] = [];
              for (const rawLine of lines) {
                const line = rawLine.replace(/\r$/, "");
                if (!line) continue;
                const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
                // Always compute the relative path lexically. A `startsWith(searchPath)`
                // prefix check is wrong at the filesystem root (off-by-one) and for
                // sibling paths that merely share a string prefix (e.g. "/a/bc" vs "/a/bcd").
                let relativePath = path.relative(searchPath, line);
                if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
                relativized.push(toPosixPath(relativePath));
              }

              if (code !== 0) {
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
              if (!output) {
                settle(() => resolve({ content: [{ type: "text" as const, text: "No files found matching pattern" }], details: undefined }));
                return;
              }

              // fd was asked for effectiveLimit + 1 entries, so a full buffer means
              // real overflow; exactly N matches stay hint-free. Output is capped
              // at effectiveLimit either way.
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
