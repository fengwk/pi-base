import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { createFindToolDefinition as createUpstreamFindToolDefinition } from "@earendil-works/pi-coding-agent";
import { ensureTool } from "./internal/pi-coding-agent-utils.js";
import { resolveToCwd } from "./path-utils.js";
import { createGracefulTerminator } from "./process-termination.js";

const DEFAULT_LIMIT = 1000;

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
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
        let cleanup = (_keepTermination?: boolean) => undefined;

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
            const effectiveLimit = limit ?? DEFAULT_LIMIT;
            const fdPath = await ensureTool("fd", true);
            if (!fdPath) {
              settle(() => reject(new Error("fd is not available and could not be downloaded")));
              return;
            }
            if (signal?.aborted) {
              onAbort();
              return;
            }

            const args = ["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", String(effectiveLimit)];
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
              if (code !== 0) {
                const errorMsg = stderr.trim() || `fd exited with code ${code}`;
                if (!output) {
                  settle(() => reject(new Error(errorMsg)));
                  return;
                }
              }
              if (!output) {
                settle(() => resolve({ content: [{ type: "text" as const, text: "No files found matching pattern" }], details: undefined }));
                return;
              }

              const relativized: string[] = [];
              for (const rawLine of lines) {
                const line = rawLine.replace(/\r$/, "").trim();
                if (!line) continue;
                const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
                // Always compute the relative path lexically. A `startsWith(searchPath)`
                // prefix check is wrong at the filesystem root (off-by-one) and for
                // sibling paths that merely share a string prefix (e.g. "/a/bc" vs "/a/bcd").
                let relativePath = path.relative(searchPath, line);
                if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
                relativized.push(toPosixPath(relativePath));
              }

              const resultLimitReached = relativized.length >= effectiveLimit;
              let resultOutput = relativized.join("\n");
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
