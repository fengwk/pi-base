import { escapeControlCharsForDisplay, formatHashlineDisplay, parseLineRef, suggestAnchorFromDisplayedLine } from "./hashline.js";

/**
 * Render leading whitespace so previews make indentation visible while keeping
 * trailing whitespace unchanged.
 */
export function visualizeLeadingWhitespace(text: string): string {
  const match = /^[ \t]*/.exec(text);
  if (!match || match[0].length === 0) return text;
  const marker = match[0].replace(/ /g, "·").replace(/\t/g, "→");
  return `${marker}${text.slice(match[0].length)}`;
}

export function formatCurrentAnchorLine(lineNumber: number, content: string, width: number): string {
  return formatHashlineDisplay(lineNumber, content, width, escapeControlCharsForDisplay(visualizeLeadingWhitespace(content)));
}

export function formatRemovedLine(lineNumber: number, content: string, width: number): string {
  const padded = width > 0 ? String(lineNumber).padStart(width, " ") : String(lineNumber);
  return `${padded}#----|${escapeControlCharsForDisplay(visualizeLeadingWhitespace(content))}`;
}

export function formatAnchorRefForDisplay(ref: string | undefined): string {
  if (typeof ref !== "string" || ref.length === 0) return "<missing-anchor>";
  const suggestedAnchor = suggestAnchorFromDisplayedLine(ref);
  if (suggestedAnchor) return `${suggestedAnchor} (invalid: remove |content)`;
  try {
    const parsed = parseLineRef(ref);
    return `${parsed.line}#${parsed.hash}`;
  } catch {
    return ref;
  }
}

export function getLineRefError(ref: string | undefined): string | undefined {
  if (typeof ref !== "string" || ref.length === 0) return "Missing anchor. Expected exactly LINE#HASH.";
  try {
    parseLineRef(ref);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

export function safeParseLineRef(ref: string | undefined): { line: number } | undefined {
  if (typeof ref !== "string" || ref.length === 0) return undefined;
  try {
    return { line: parseLineRef(ref).line };
  } catch {
    return undefined;
  }
}
