import type { ApplyPatchOperation, ParsedApplyPatch } from "./apply-patch-core.js";

export type ApplyPatchPreviewLine =
  | { kind: "file"; text: string; operation: ApplyPatchOperation }
  | { kind: "add" | "delete" | "context" | "meta" | "blank"; text: string };

export interface ApplyPatchPreview {
  lines: ApplyPatchPreviewLine[];
  omittedLines: number;
}

export interface ApplyPatchPreviewOptions {
  maxLines?: number;
  maxLineChars?: number;
  maxAddLines?: number;
}

export function applyPatchOperationLabel(operation: ApplyPatchOperation): "A" | "M" | "D" {
  if (operation === "add") return "A";
  if (operation === "delete") return "D";
  return "M";
}

function truncateLine(text: string, maxChars: number | undefined): string {
  if (maxChars === undefined || text.length <= maxChars) return text;
  if (maxChars <= 3) return ".".repeat(Math.max(0, maxChars));
  return `${text.slice(0, maxChars - 3)}...`;
}

function normalizePreviewLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function* iteratePreviewLines(
  patch: ParsedApplyPatch,
  maxAddLines: number | undefined,
): Generator<ApplyPatchPreviewLine> {
  let firstFile = true;
  for (const file of patch.files) {
    if (!firstFile) yield { kind: "blank", text: "" };
    firstFile = false;
    const target = file.operation === "update" && file.moveTo !== undefined
      ? `${file.path} -> ${file.moveTo}`
      : file.path;
    yield {
      kind: "file",
      operation: file.operation,
      text: `${applyPatchOperationLabel(file.operation)} ${target}`,
    };

    if (file.operation === "add") {
      if (file.lines.length === 0) yield { kind: "meta", text: "(empty file)" };
      else {
        const visibleCount = maxAddLines === undefined ? file.lines.length : Math.min(maxAddLines, file.lines.length);
        for (const line of file.lines.slice(0, visibleCount)) yield { kind: "add", text: `+${line}` };
        const remaining = file.lines.length - visibleCount;
        if (remaining > 0) {
          yield {
            kind: "meta",
            text: `... (${remaining} more ${remaining === 1 ? "line" : "lines"}, ${file.lines.length} total)`,
          };
        }
      }
      continue;
    }

    if (file.operation === "delete") {
      yield { kind: "meta", text: "(delete file)" };
      continue;
    }

    for (const chunk of file.chunks) {
      yield {
        kind: "meta",
        text: chunk.changeContext === undefined ? "@@" : `@@ ${chunk.changeContext}`,
      };
      for (const line of chunk.lines) {
        const marker = line.kind === "context" ? " " : line.kind === "delete" ? "-" : "+";
        yield { kind: line.kind, text: `${marker}${line.text}` };
      }
      if (chunk.endOfFile) yield { kind: "meta", text: "*** End of File" };
    }
  }
}

function* iterateRawPreviewLines(text: string): Generator<ApplyPatchPreviewLine> {
  let lineStart = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char !== "\n" && char !== "\r") continue;
    yield { kind: "meta", text: text.slice(lineStart, index) };
    if (char === "\r" && text[index + 1] === "\n") index++;
    lineStart = index + 1;
  }
  yield { kind: "meta", text: text.slice(lineStart) };
}

function buildBoundedPreview(
  source: Iterable<ApplyPatchPreviewLine>,
  options: ApplyPatchPreviewOptions,
): ApplyPatchPreview {
  const maxLineChars = normalizePreviewLimit(options.maxLineChars);
  const maxLines = normalizePreviewLimit(options.maxLines);
  const lines: ApplyPatchPreviewLine[] = [];
  let totalLines = 0;
  for (const line of source) {
    totalLines++;
    if (maxLines !== undefined && lines.length >= maxLines) continue;
    lines.push({ ...line, text: truncateLine(line.text, maxLineChars) });
  }
  if (maxLines === undefined || totalLines <= maxLines) return { lines, omittedLines: 0 };
  if (maxLines === 0) return { lines: [], omittedLines: totalLines };

  const visibleCount = maxLines - 1;
  const omittedLines = totalLines - visibleCount;
  return {
    lines: [
      ...lines.slice(0, visibleCount),
      { kind: "meta", text: `... (${omittedLines} more patch lines)` },
    ],
    omittedLines,
  };
}

export function buildApplyPatchPreview(
  patch: ParsedApplyPatch,
  options: ApplyPatchPreviewOptions = {},
): ApplyPatchPreview {
  return buildBoundedPreview(iteratePreviewLines(patch, normalizePreviewLimit(options.maxAddLines)), options);
}

export function buildRawApplyPatchPreview(
  text: string,
  options: ApplyPatchPreviewOptions = {},
): ApplyPatchPreview {
  return buildBoundedPreview(iterateRawPreviewLines(text), options);
}

export function formatApplyPatchPreview(preview: ApplyPatchPreview): string {
  return preview.lines.map((line) => line.text).join("\n");
}
