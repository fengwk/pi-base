import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureHashInit, formatHashlineDisplay } from "./hashline.js";
import { resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import { shortenHomePath, styleAccent, styleMuted, styleToolTitle } from "./render.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";

export const WRITE_COLLAPSED_PREVIEW_LINES = 10;

export function formatHashlineOutput(content: string): string {
  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines.map((line, index) => formatHashlineDisplay(index + 1, line, width)).join("\n");
}

export function formatWriteSuccess(rawPath: string, existed: boolean, content: string): string {
  const action = existed ? "Overwrote" : "Created";
  return `${action} ${rawPath}.\nReview the written file content below. Lines prefixed with digits carry LINE#HASH anchors for follow-up edits.\n\n${formatHashlineOutput(content)}`;
}

export function formatWriteCall(args: any, theme: any): string {
  const path = shortenHomePath(String(args?.path ?? "<missing-path>"));
  const workdir = `${styleMuted(theme, " in ")}${styleAccent(theme, args?.workdir === undefined ? "<missing-workdir>" : shortenHomePath(String(args.workdir)))}`;
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
  } = {},
): Promise<any> {
  try {
    await ensureHashInit();
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
      throwIfAborted(signal);
      await throwIfAbortedAfter(writeFile(absolutePath, content, "utf8"), signal);
      options.onFileAnchored?.(absolutePath, content.split("\n"));
      options.onSuccessfulWrite?.(absolutePath);
      return {
        content: [{ type: "text" as const, text: formatWriteSuccess(rawPath, existed, content) }],
      };
    });
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
  }
}
