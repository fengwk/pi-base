import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeToolWorkdirForDisplay, resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import { shortenHomePath, styleAccent, styleMuted, styleToolTitle } from "./render.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";
import { bomKindForEncoding, defaultTextEncoding, detectTextFileEncoding, encodeTextFile, textStartsWithBomMarker } from "./text-codec.js";

export function formatWriteSuccess(rawPath: string, existed: boolean): string {
  const action = existed ? "Overwrote" : "Created";
  return `${action} ${rawPath} successfully.`;
}

export function formatWriteCall(args: any, theme: any, cwd?: string): string {
  const path = shortenHomePath(String(args?.path ?? "<missing-path>"));
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleMuted(theme, " in ")}${styleAccent(theme, shortenHomePath(rawWorkdir))}`;
  const content = String(args?.content ?? "");
  return `${styleToolTitle(theme, "write")} ${styleAccent(theme, path)}${workdir}\n\n${content}`;
}

export async function executeWrite(
  params: any,
  signal?: AbortSignal,
  ctx: any = {},
  options: {
    onSuccessfulWrite?: (absolutePath: string) => void;
  } = {},
): Promise<any> {
  try {
    throwIfAborted(signal);
    const rawPath = String(params.path ?? "").replace(/^@/, "");
    if (!rawPath) throw new Error("path is required.");
    if (!Object.prototype.hasOwnProperty.call(params ?? {}, "content") || typeof params.content !== "string") {
      throw new Error("content is required and must be a string.");
    }
    const content = params.content;
    const { cwd } = resolveToolWorkdir(params.workdir, ctx.cwd ?? process.cwd());
    const absolutePath = resolveToCwd(rawPath, cwd);
    return await withFileMutationQueue(absolutePath, async () => {
      throwIfAborted(signal);
      let existed = true;
      let outputEncoding = defaultTextEncoding();
      let outputBom = textStartsWithBomMarker(content) ? bomKindForEncoding(outputEncoding) : "none";
      try {
        await throwIfAbortedAfter(stat(absolutePath), signal);
        const currentBytes = await throwIfAbortedAfter(readFile(absolutePath), signal);
        const detected = detectTextFileEncoding(currentBytes);
        outputEncoding = detected.encoding;
        outputBom = detected.bom !== "none" ? detected.bom : (textStartsWithBomMarker(content) ? bomKindForEncoding(outputEncoding) : "none");
      } catch {
        existed = false;
      }
      const output = encodeTextFile(content, outputEncoding, outputBom);
      await throwIfAbortedAfter(mkdir(dirname(absolutePath), { recursive: true }), signal);
      await throwIfAbortedAfter(writeFile(absolutePath, output), signal);
      options.onSuccessfulWrite?.(absolutePath);
      return {
        content: [{ type: "text" as const, text: formatWriteSuccess(rawPath, existed) }],
      };
    });
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
  }
}
