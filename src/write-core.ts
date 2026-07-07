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
  const hasPath = typeof args?.path === "string" && args.path.length > 0;
  const pathSegment = hasPath ? ` ${styleAccent(theme, shortenHomePath(String(args.path)))}` : "";
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleMuted(theme, " in ")}${styleAccent(theme, shortenHomePath(rawWorkdir))}`;
  const content = typeof args?.content === "string" ? args.content : "";
  const body = content.length > 0 ? `\n\n${content}` : "";
  // Render only the parts that have arrived: the path and content blocks are omitted
  // entirely until present, so a streaming call grows part-by-part instead of showing
  // placeholders for arguments that have not streamed in yet.
  return `${styleToolTitle(theme, "write")}${pathSegment}${workdir}${body}`;
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
