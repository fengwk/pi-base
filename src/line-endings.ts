export type LineEndingStyle = "\r\n" | "\n" | "\r" | "mixed";
export type ConcreteLineEnding = Exclude<LineEndingStyle, "mixed">;

export interface ParsedLineEndingDocument {
  lines: string[];
  eolAfter: Array<ConcreteLineEnding | null>;
  defaultEnding: ConcreteLineEnding;
}

export function detectLineEnding(content: string): LineEndingStyle {
  const hasCRLF = content.includes("\r\n");
  const withoutCRLF = content.replace(/\r\n/g, "");
  const hasCR = withoutCRLF.includes("\r");
  const hasLF = withoutCRLF.includes("\n");
  const styles = [hasCRLF, hasCR, hasLF].filter(Boolean).length;
  if (styles > 1) return "mixed";
  if (hasCRLF) return "\r\n";
  if (hasCR) return "\r";
  return "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: ConcreteLineEnding): string {
  if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
  if (ending === "\r") return text.replace(/\n/g, "\r");
  return text;
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

export function parseLineEndingDocument(content: string): ParsedLineEndingDocument {
  const lines: string[] = [];
  const eolAfter: Array<ConcreteLineEnding | null> = [];
  let current = "";
  let defaultEnding: ConcreteLineEnding | undefined;

  for (let index = 0; index < content.length; index++) {
    const ch = content[index]!;
    if (ch === "\r") {
      const ending: ConcreteLineEnding = content[index + 1] === "\n" ? "\r\n" : "\r";
      if (ending === "\r\n") index++;
      lines.push(current);
      eolAfter.push(ending);
      defaultEnding ??= ending;
      current = "";
      continue;
    }
    if (ch === "\n") {
      lines.push(current);
      eolAfter.push("\n");
      defaultEnding ??= "\n";
      current = "";
      continue;
    }
    current += ch;
  }

  lines.push(current);
  eolAfter.push(null);
  return { lines, eolAfter, defaultEnding: defaultEnding ?? "\n" };
}

export function serializeLineEndingDocument(document: Pick<ParsedLineEndingDocument, "lines" | "eolAfter">): string {
  if (document.lines.length !== document.eolAfter.length) {
    throw new Error("Line ending document is inconsistent: lines and eolAfter must have the same length.");
  }
  return document.lines.map((line, index) => `${line}${document.eolAfter[index] ?? ""}`).join("");
}
