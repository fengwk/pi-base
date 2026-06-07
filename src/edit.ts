import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { readFile, writeFile } from "node:fs/promises";
import { detectLineEnding, generateCompactOrFullDiff, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.js";
import { applyHashlineEdits, ensureHashInit, HashlineMismatchError, type HashlineEditItem } from "./hashline.js";
import { buildEditCallPreviewSignature, rememberEditCallPreviewSnapshot, renderEditCall, type EditCallPreviewSnapshots } from "./edit-preview.js";
import { buildNoChangeError, buildResultDiff, buildStaleError } from "./edit-result.js";
import { resolveToCwd, resolveToolWorkdir, stripAtPrefix } from "./path-utils.js";
import { type CollapsedResultLinesResolver, renderRawResult, resolveCollapsedResultLines } from "./render.js";
import { editSchema } from "./schemas/edit.js";
import { loadToolDescription, loadToolPromptSnippet } from "./tool-prompt.js";
import { throwIfAborted, throwIfAbortedAfter } from "./runtime.js";

const EDIT_ARGUMENT_VALIDATION_HINT = "Hint: Adjust the input parameters and re-run the `edit` command.";

function prepareEditArguments(args: unknown, validationTool: any): any {
  try {
    return validateToolArguments(validationTool, {
      type: "toolCall",
      id: "edit-argument-validation",
      name: "edit",
      arguments: args as any,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n\n${EDIT_ARGUMENT_VALIDATION_HINT}`);
  }
}

export function registerEditTool(
  pi: ExtensionAPI,
  options: {
    wasReadInSession?: (absolutePath: string) => boolean;
    getCollapsedResultLines?: CollapsedResultLinesResolver;
    getCachedLines?: (absolutePath: string) => string[] | undefined;
    onSuccessfulEdit?: (absolutePath: string, lines?: string[]) => void;
  } = {},
) {
  const callPreviewSnapshots: EditCallPreviewSnapshots = new Map();
  const description = loadToolDescription("edit");
  const promptSnippet = loadToolPromptSnippet("edit");
  const validationTool = { name: "edit", description, parameters: editSchema };
  const tool = {
    name: "edit",
    label: "Edit",
    description,
    promptSnippet,
    prepareArguments(args: unknown) {
      return prepareEditArguments(args, validationTool);
    },
    parameters: editSchema,
    renderShell: "default" as const,
    renderCall(args: any, theme: any, context: any) {
      return renderEditCall(args, theme, context, callPreviewSnapshots, { getCachedLines: options.getCachedLines });
    },
    renderResult(result: any, renderOptions: any, theme: any, context: any) {
      const collapsedLines = resolveCollapsedResultLines("edit", undefined, context, options.getCollapsedResultLines);
      return renderRawResult(result, { ...renderOptions, collapsedLines }, theme, context);
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: any, ctx: any = {}) {
      try {
        await ensureHashInit();
        throwIfAborted(signal);
        const rawPath = stripAtPrefix(String(params.path ?? ""));
        if (!rawPath) throw new Error("path is required.");
        if (!Array.isArray(params.edits) || params.edits.length === 0) throw new Error("edits must be a non-empty array.");
        const operationKeys = ["replace_lines", "delete_lines", "insert_before_lines", "insert_after_lines"] as const;
        for (const item of params.edits) {
          const present = operationKeys.filter((key) => item && Object.prototype.hasOwnProperty.call(item, key));
          if (present.length !== 1) {
            throw new Error("Each edit item must contain exactly one operation: `replace_lines`, `delete_lines`, `insert_before_lines`, or `insert_after_lines`.");
          }
        }
        const { cwd } = resolveToolWorkdir(params.workdir, ctx.cwd ?? process.cwd());
        const absolutePath = resolveToCwd(rawPath, cwd);
        const previewSignature = buildEditCallPreviewSignature(absolutePath, params);
        if (options.wasReadInSession && !options.wasReadInSession(absolutePath)) {
          return {
            content: [{ type: "text" as const, text: `Edit failed for ${rawPath}. Fresh anchors are required before editing this file. Start with read, write, or a prior edit result for the same region.` }],
            isError: true,
          };
        }

        return withFileMutationQueue(absolutePath, async () => {
          throwIfAborted(signal);
          const raw = await throwIfAbortedAfter(readFile(absolutePath, "utf8"), signal);
          const { bom, text } = stripBom(raw);
          const originalEnding = detectLineEnding(text);
          if (originalEnding === "mixed") {
            return {
              content: [{ type: "text" as const, text: `Edit failed for ${rawPath}. Mixed line endings are not supported. Normalize the file to a single line ending style before editing.` }],
              isError: true,
            };
          }
          const original = normalizeToLF(text);
          rememberEditCallPreviewSnapshot(callPreviewSnapshots, previewSignature, original.split("\n"));
          let next;
          try {
            next = applyHashlineEdits(original, params.edits as HashlineEditItem[], signal);
          } catch (error) {
            if (error instanceof HashlineMismatchError) return buildStaleError(rawPath, error);
            return { content: [{ type: "text" as const, text: `Edit failed for ${rawPath}. ${(error as Error).message}` }], isError: true };
          }

          if (next.content === original) {
            return buildNoChangeError(rawPath, original, params.edits);
          }

          const writeContent = bom + restoreLineEndings(next.content, originalEnding);
          throwIfAborted(signal);
          await throwIfAbortedAfter(writeFile(absolutePath, writeContent, "utf8"), signal);
          const nextLines = next.content.split("\n");
          options.onSuccessfulEdit?.(absolutePath, nextLines);

          const diffText = buildResultDiff(original, next.content);
          const diff = generateCompactOrFullDiff(original, next.content).diff;

          return {
            content: [{ type: "text" as const, text: `Edit applied to ${rawPath}.\nReview the diff below. Use only LINE#HASH anchors from lines prefixed with "+" or "|" for follow-up edits in this region; lines prefixed with "-" are old/deleted content and intentionally do not carry reusable anchors.\n\n${diffText}` }],
            details: { diff },
          };
        });
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Edit failed. ${(error as Error).message}` }], isError: true };
      }
    },
  };
  pi.registerTool(tool as any);
  return tool;
}
