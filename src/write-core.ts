import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeToolWorkdirForDisplay, resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import { shortenHomePath, styleAccent, styleMuted, styleOutput, styleToolTitle } from "./render.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";
import { bomKindForEncoding, defaultTextEncoding, detectTextFileEncoding, encodeTextFile, textStartsWithBomMarker } from "./text-codec.js";

export function formatWriteSuccess(rawPath: string, existed: boolean): string {
  const action = existed ? "Overwrote" : "Created";
  return `${action} ${rawPath} successfully.`;
}

// Number of content lines shown in the collapsed call preview once the tool has finished
// applying. Matches the upstream write tool's historical collapsed-line cap.
export const WRITE_COLLAPSED_CALL_PREVIEW_LINES = 10;

function splitWriteContentLines(content: string): string[] {
  if (!content) return [];
  // Trailing newline produces a phantom empty line; mirror read/edit behavior and drop it
  // so line counts only count content-bearing (and explicit blank) lines.
  const lines = content.split("\n");
  if (content.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function formatWriteCall(
  args: any,
  theme: any,
  cwd?: string,
  options: { collapsed?: boolean } = {},
): string {
  const hasPath = typeof args?.path === "string" && args.path.length > 0;
  const pathSegment = hasPath ? ` ${styleAccent(theme, shortenHomePath(String(args.path)))}` : "";
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleMuted(theme, " in ")}${styleAccent(theme, shortenHomePath(rawWorkdir))}`;
  const header = `${styleToolTitle(theme, "write")}${pathSegment}${workdir}`;

  const rawContent = typeof args?.content === "string" ? args.content : "";
  if (rawContent.length === 0) return header;

  const allLines = splitWriteContentLines(rawContent);
  if (allLines.length === 0) return header;

  // Collapsed preview: show the first N content lines and a hint about how many more
  // were not displayed. The un-collapsed path keeps the full body so that "expanded"
  // and "in-progress" modes still let the user read every byte.
  if (options.collapsed) {
    const visibleCount = Math.max(0, Math.min(WRITE_COLLAPSED_CALL_PREVIEW_LINES, allLines.length));
    const visibleLines = allLines.slice(0, visibleCount);
    const remaining = allLines.length - visibleCount;
    const visibleBody = visibleLines.map((line) => styleOutput(theme, line)).join("\n");
    let body = visibleBody;
    if (remaining > 0) {
      const hint = styleMuted(
        theme,
        `... (${remaining} more ${remaining === 1 ? "line" : "lines"}, ${allLines.length} total)`,
      );
      body = `${visibleBody}\n${hint}`;
    }
    return `${header}\n\n${body}`;
  }

  // Render only the parts that have arrived: the path and content blocks are omitted
  // entirely until present, so a streaming call grows part-by-part instead of showing
  // placeholders for arguments that have not streamed in yet.
  return `${header}\n\n${rawContent}`;
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
