import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  createFindToolDefinition as createUpstreamFindToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { ensureTool } from "../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js";
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
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };
        let cleanup = () => undefined;

        const onAbort = () => {
          aborted = true;
          terminator?.terminate();
          settle(() => reject(new Error("Operation aborted")));
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

            cleanup = () => {
              rl.close();
              signal?.removeEventListener("abort", onAbort);
              terminator?.cleanup();
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
                let relativePath = line;
                if (line.startsWith(searchPath)) relativePath = line.slice(searchPath.length + 1);
                else relativePath = path.relative(searchPath, line);
                if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
                relativized.push(toPosixPath(relativePath));
              }

              const resultLimitReached = relativized.length >= effectiveLimit;
              const rawOutput = relativized.join("\n");
              const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
              let resultOutput = truncation.content;
              const details: Record<string, unknown> = {};
              const notices: string[] = [];
              if (resultLimitReached) {
                notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
                details.resultLimitReached = effectiveLimit;
              }
              if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                details.truncation = truncation;
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
