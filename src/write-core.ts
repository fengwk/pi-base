import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { describeToolWorkdirForDisplay, resolveToCwd, resolveToolWorkdir } from "./path-utils.js";
import { shortenHomePath, styleAccent, styleMuted, styleOutput, styleToolTitle } from "./render.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";
import {
  type DecodedTextFile,
  type TextBomKind,
  type TextEncoding,
  decodeTextFile,
  encodeTextFile,
  formatTextFileError,
  resolveContentEncoding,
  resolveDeclaredEncoding,
} from "./text-codec.js";

export function formatWriteSuccess(rawPath: string, existed: boolean): string {
  const action = existed ? "Overwrote" : "Created";
  return `${action} ${rawPath} successfully.`;
}

/** The encoding the rewritten file must use: an existing BOM wins, then the new content's declaration. */
function resolveWriteEncoding(
  absolutePath: string,
  rawPath: string,
  content: string,
  existing: DecodedTextFile | undefined,
): { encoding: TextEncoding; bom: TextBomKind } {
  if (!existing || existing.bom === "none") {
    const target = resolveContentEncoding(content, absolutePath);
    const contentDeclares = resolveDeclaredEncoding(content, absolutePath, "none");
    const existingDeclares = existing && resolveDeclaredEncoding(existing.text, absolutePath, "none");
    if (existingDeclares && !contentDeclares && existingDeclares.name !== "UTF-8") {
      throw new Error(
        `The new content removes the ${existingDeclares.name} declaration of ${rawPath}. `
        + "Keep the declaration, or declare the new encoding explicitly to convert the file.",
      );
    }
    return target;
  }
  const declared = resolveDeclaredEncoding(content, absolutePath, existing.bom);
  if (declared && declared.name !== existing.encoding.name) {
    throw new Error(
      `The new content declares ${declared.name}, but ${rawPath} is ${existing.encoding.name} with a ${existing.bom} byte order mark. `
      + "Keep the existing declaration, or delete the file first to convert it.",
    );
  }
  return { encoding: existing.encoding, bom: existing.bom };
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
// Number of content lines shown in the collapsed call preview once the tool has finished
// applying. Aligned with the streaming rolling window's body-line tail (see
// STREAMING_CALL_PREVIEW_LINES in render.ts: 10 total, with 3 reserved for the title
// / blank / hint, leaving 7 body lines) so the collapsed call and the streaming
// call have the same overall height.
export const WRITE_COLLAPSED_CALL_PREVIEW_LINES = 7;

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
    const { existed } = await withFileMutationQueue(absolutePath, async () => {
      throwIfAborted(signal);
      let existing: DecodedTextFile | undefined;
      try {
        const currentStat = await throwIfAbortedAfter(stat(absolutePath), signal);
        if (!currentStat.isFile()) throw new Error(`${rawPath} is not a regular file. write supports regular text files only.`);
        const currentBytes = await throwIfAbortedAfter(readFile(absolutePath), signal);
        try {
          existing = decodeTextFile(currentBytes, absolutePath);
        } catch (error) {
          throw new Error(`${formatTextFileError(error, rawPath, "written")} write supports text files only.`);
        }
      } catch (error) {
        if (!isFileNotFoundError(error)) throw error;
      }
      const { encoding, bom } = resolveWriteEncoding(absolutePath, rawPath, content, existing);
      const output = encodeTextFile(content, encoding, bom);
      await throwIfAbortedAfter(mkdir(dirname(absolutePath), { recursive: true }), signal);
      // Once the write starts, let it settle and report the committed result. A post-write abort
      // cannot roll the file back and must not hide the mutation from downstream bookkeeping.
      await writeFileAtomic(absolutePath, output);
      return { existed: existing !== undefined };
    });
    try {
      options.onSuccessfulWrite?.(absolutePath);
    } catch {
      // Observer failures cannot roll back the committed write.
    }
    return {
      content: [{ type: "text" as const, text: formatWriteSuccess(rawPath, existed) }],
    };
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
  }
}
