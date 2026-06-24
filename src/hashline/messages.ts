import { formatNumberedLine, HL_FILE_HASH_EXAMPLES, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX, HL_RANGE_SEP } from "./format.js";

export const MISMATCH_CONTEXT = 2;

export function formatAnchoredContext(anchorLines: readonly number[], fileLines: readonly string[]): string[] {
  const displayLines = new Set<number>();
  for (const line of anchorLines) {
    if (line < 1 || line > fileLines.length) continue;
    const start = Math.max(1, line - MISMATCH_CONTEXT);
    const end = Math.min(fileLines.length, line + MISMATCH_CONTEXT);
    for (let current = start; current <= end; current++) displayLines.add(current);
  }
  const anchors = new Set(anchorLines);
  const rows: string[] = [];
  let previous = -1;
  for (const line of [...displayLines].sort((a, b) => a - b)) {
    if (previous !== -1 && line > previous + 1) rows.push("...");
    previous = line;
    rows.push(`${anchors.has(line) ? "*" : " "}${formatNumberedLine(line, fileLines[line - 1] ?? "")}`);
  }
  return rows;
}

export function missingSnapshotTagMessage(sectionPath: string): string {
  return `Missing hashline snapshot tag for ${sectionPath}; use a header copied from the latest read, write, or successful edit result, for example ${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}${HL_FILE_HASH_EXAMPLES[0]}${HL_FILE_SUFFIX}. Use write to create new files.`;
}

function formatLineRanges(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0]!;
  let previous = sorted[0]!;
  for (let index = 1; index <= sorted.length; index++) {
    const current = sorted[index];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = current!;
    previous = current!;
  }
  return parts.join(", ");
}

export function unseenLinesMessage(sectionPath: string, unseenLines: readonly number[], tag: string): string {
  const ranges = formatLineRanges(unseenLines);
  return (
    `This patch touches lines ${ranges} of ${sectionPath} that ${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}${tag}${HL_FILE_SUFFIX} did not display. ` +
    `Read those exact lines first with a window that explicitly includes them, then copy the fresh header and retry.`
  );
}

export const BLOCK_OPS_DISABLED_MESSAGE =
  "Block operations are not supported in pi-base. Read the full target range, then use explicit `SWAP N.=M:`, `DEL N.=M`, `INS.PRE N:`, or `INS.POST N:` operations.";

export const BODY_ROWS_REQUIRE_PLUS_MESSAGE =
  "Body rows must start with `+`. The body contains only final file content; never write bare context lines or unified-diff `-old` rows.";

export const BLANK_BODY_ROW_MESSAGE = "Blank lines inside a body must be written as a lone `+`.";

export function overlappingRangeMessage(firstStart: number, firstEnd: number, secondStart: number, secondEnd: number): string {
  return `Explicit ranges must not overlap. Existing range ${firstStart}${HL_RANGE_SEP}${firstEnd} overlaps ${secondStart}${HL_RANGE_SEP}${secondEnd}. Split the edit into non-overlapping ranges or combine it into one SWAP body.`;
}

export function insertInsideRangeMessage(anchorLine: number, startLine: number, endLine: number, side: "PRE" | "POST"): string {
  return `INS.${side} ${anchorLine}: lands inside explicit range ${startLine}${HL_RANGE_SEP}${endLine}. Either include that insertion inside the SWAP body, or anchor it exactly at the boundary (INS.PRE ${startLine}: / INS.POST ${endLine}:).`;
}
