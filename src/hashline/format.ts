/** Formatting helpers and stable primitives for the explicit-range hashline DSL. */

import { createHash } from "node:crypto";

export const HL_FILE_PREFIX = "[";
export const HL_FILE_SUFFIX = "]";
export const HL_FILE_HASH_SEP = "#";
export const HL_FILE_HASH_LENGTH = 4;
export const HL_FILE_HASH_EXAMPLES = ["A1B2", "3C4D", "9F3E"] as const;
export const HL_LINE_BODY_SEP = ":";
export const HL_RANGE_SEP = ".=";
export const HL_PAYLOAD_PREFIX = "+";

export const HL_REPLACE_KEYWORD = "SWAP";
export const HL_DELETE_KEYWORD = "DEL";
export const HL_INSERT_PREFIX = "INS.";
export const HL_INSERT_BEFORE = "PRE";
export const HL_INSERT_AFTER = "POST";
export const HL_INSERT_HEAD = "HEAD";
export const HL_INSERT_TAIL = "TAIL";

/** Normalize text before hashing so line-ending display artifacts do not perturb tags. */
function normalizeFileHashText(text: string): string {
  return text.replace(/[ \t\r]+(?=\n|$)/g, "");
}

/** Stable 4-hex content tag for a normalized file snapshot. */
export function computeFileHash(text: string): string {
  return createHash("sha256").update(normalizeFileHashText(text)).digest("hex").slice(0, HL_FILE_HASH_LENGTH).toUpperCase();
}

export function formatHashlineHeader(path: string, fileHash: string): string {
  return `${HL_FILE_PREFIX}${path}${HL_FILE_HASH_SEP}${fileHash}${HL_FILE_SUFFIX}`;
}

export function formatNumberedLine(lineNumber: number, content: string): string {
  return `${lineNumber}${HL_LINE_BODY_SEP}${content}`;
}

/** Split normalized file text into the lines we actually show to the agent. */
export function splitDisplayedLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function formatNumberedLines(text: string, startLine = 1): string {
  return splitDisplayedLines(text).map((line, index) => formatNumberedLine(startLine + index, line)).join("\n");
}
