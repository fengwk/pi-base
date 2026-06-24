import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { formatHashlineHeader, formatNumberedLines, InMemorySnapshotStore, normalizeToLF, splitDisplayedLines, stripBom } from "./hashline/index.js";
import { recordNormalizedSnapshot } from "./hashline-session.js";
import { describeToolWorkdirForDisplay, resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import { shortenHomePath, styleAccent, styleMuted, styleToolTitle } from "./render.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";

export const WRITE_COLLAPSED_PREVIEW_LINES = 10;

function normalizeWrittenText(content: string): string {
  return normalizeToLF(stripBom(content).text);
}

export function formatWriteSuccess(rawPath: string, existed: boolean, normalizedContent: string, tag: string | undefined): string {
  const action = existed ? "Overwrote" : "Created";
  const header = tag ? `${formatHashlineHeader(rawPath, tag)}\n` : "";
  return `${action} ${rawPath}.\nReview the current file snapshot below and reuse its header for follow-up hashline edits.\n\n${header}${formatNumberedLines(normalizedContent)}`;
}

export function formatWriteCall(args: any, theme: any, cwd?: string): string {
  const path = shortenHomePath(String(args?.path ?? "<missing-path>"));
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleMuted(theme, " in ")}${styleAccent(theme, shortenHomePath(rawWorkdir))}`;
  const content = String(args?.content ?? "");
  return `${styleToolTitle(theme, "write")} ${styleAccent(theme, path)}${workdir}\n\n${content.split("\n").join("\n")}`;
}

export async function executeWrite(
  params: any,
  signal?: AbortSignal,
  ctx: any = {},
  options: {
    onFileAnchored?: (absolutePath: string, lines?: string[]) => void;
    onSuccessfulWrite?: (absolutePath: string) => void;
    snapshots?: InMemorySnapshotStore;
  } = {},
): Promise<any> {
  try {
    throwIfAborted(signal);
    const rawPath = String(params.path ?? "").replace(/^@/, "");
    if (!rawPath) throw new Error("path is required.");
    const content = String(params.content ?? "");
    const { cwd } = resolveToolWorkdir(params.workdir, ctx.cwd ?? process.cwd());
    const absolutePath = resolveToCwd(rawPath, cwd);
    return withFileMutationQueue(absolutePath, async () => {
      throwIfAborted(signal);
      let existed = true;
      try {
        await throwIfAbortedAfter(stat(absolutePath), signal);
      } catch {
        existed = false;
      }
      await throwIfAbortedAfter(mkdir(dirname(absolutePath), { recursive: true }), signal);
      await throwIfAbortedAfter(writeFile(absolutePath, content, "utf8"), signal);
      const normalized = normalizeWrittenText(content);
      const tag = options.snapshots ? recordNormalizedSnapshot(options.snapshots, absolutePath, normalized) : undefined;
      options.onFileAnchored?.(absolutePath, splitDisplayedLines(normalized));
      options.onSuccessfulWrite?.(absolutePath);
      return {
        content: [{ type: "text" as const, text: formatWriteSuccess(rawPath, existed, normalized, tag) }],
      };
    });
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
  }
}
