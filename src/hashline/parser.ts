import {
  HL_DELETE_KEYWORD,
  HL_FILE_HASH_LENGTH,
  HL_FILE_HASH_SEP,
  HL_FILE_PREFIX,
  HL_FILE_SUFFIX,
  HL_INSERT_AFTER,
  HL_INSERT_BEFORE,
  HL_INSERT_HEAD,
  HL_INSERT_PREFIX,
  HL_INSERT_TAIL,
  HL_PAYLOAD_PREFIX,
  HL_RANGE_SEP,
  HL_REPLACE_KEYWORD,
} from "./format.js";
import { BLANK_BODY_ROW_MESSAGE, BLOCK_OPS_DISABLED_MESSAGE, BODY_ROWS_REQUIRE_PLUS_MESSAGE } from "./messages.js";
import type { HashlineOperation, ParsedSectionData } from "./types.js";

export interface ParseOptions {
  cwd?: string;
}

interface PendingOperation {
  operation: HashlineOperation;
  expectsBody: boolean;
}

function normalizeInput(input: string): string {
  const strippedBom = input.startsWith("\uFEFF") ? input.slice(1) : input;
  return strippedBom.replace(/\r\n?/g, "\n");
}

function isPositiveLineNumber(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

function parseHeader(line: string, lineNumber: number): { path: string; fileHash: string } | undefined {
  const trimmed = line.trim();
  const match = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/i.exec(trimmed);
  if (!match) return undefined;
  const path = match[1]?.trim() ?? "";
  const fileHash = (match[2] ?? "").toUpperCase();
  if (!path) throw new Error(`line ${lineNumber}: hashline section header is empty. Expected ${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}TAG${HL_FILE_SUFFIX}.`);
  return { path, fileHash };
}

function parseRange(rawStart: string, rawEnd: string | undefined, lineNumber: number): { startLine: number; endLine: number } {
  if (!isPositiveLineNumber(rawStart)) throw new Error(`line ${lineNumber}: invalid line number ${JSON.stringify(rawStart)}.`);
  const startLine = Number(rawStart);
  const endText = rawEnd ?? rawStart;
  if (!isPositiveLineNumber(endText)) throw new Error(`line ${lineNumber}: invalid line number ${JSON.stringify(endText)}.`);
  const endLine = Number(endText);
  if (endLine < startLine) {
    throw new Error(`line ${lineNumber}: range ${startLine}${HL_RANGE_SEP}${endLine} ends before it starts.`);
  }
  return { startLine, endLine };
}

function parseOperation(line: string, lineNumber: number): PendingOperation | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("*** Begin Patch") || trimmed.startsWith("*** End Patch") || trimmed.startsWith("*** Abort")) {
    throw new Error(`line ${lineNumber}: patch envelopes are not used here. Start directly with ${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}${"A1B2"}${HL_FILE_SUFFIX}.`);
  }
  if (trimmed.startsWith("@@")) {
    throw new Error(`line ${lineNumber}: unified-diff hunk headers are not valid here. Use explicit ${HL_REPLACE_KEYWORD} / ${HL_DELETE_KEYWORD} / ${HL_INSERT_PREFIX}* operations.`);
  }
  if (trimmed.startsWith("SWAP.BLK") || trimmed.startsWith("DEL.BLK") || trimmed.startsWith("INS.BLK.POST")) {
    throw new Error(`line ${lineNumber}: ${BLOCK_OPS_DISABLED_MESSAGE}`);
  }

  let match = /^SWAP\s+([1-9]\d*)\.=([1-9]\d*)\s*:\s*$/.exec(trimmed);
  if (match) {
    const { startLine, endLine } = parseRange(match[1]!, match[2]!, lineNumber);
    return {
      operation: { kind: "swap", startLine, endLine, lines: [], sourceLine: lineNumber },
      expectsBody: true,
    };
  }

  match = /^DEL\s+([1-9]\d*)(?:\.=([1-9]\d*))?\s*$/.exec(trimmed);
  if (match) {
    const { startLine, endLine } = parseRange(match[1]!, match[2], lineNumber);
    return {
      operation: { kind: "delete", startLine, endLine, sourceLine: lineNumber },
      expectsBody: false,
    };
  }

  match = /^INS\.(PRE|POST)\s+([1-9]\d*)\s*:\s*$/.exec(trimmed);
  if (match) {
    const anchorLine = Number(match[2]!);
    return {
      operation: {
        kind: match[1] === HL_INSERT_BEFORE ? "insert_before" : "insert_after",
        anchorLine,
        lines: [],
        sourceLine: lineNumber,
      },
      expectsBody: true,
    };
  }

  if (/^INS\.HEAD\s*:\s*$/.test(trimmed)) {
    return { operation: { kind: "insert_head", lines: [], sourceLine: lineNumber }, expectsBody: true };
  }
  if (/^INS\.TAIL\s*:\s*$/.test(trimmed)) {
    return { operation: { kind: "insert_tail", lines: [], sourceLine: lineNumber }, expectsBody: true };
  }

  return undefined;
}

function operationBody(operation: HashlineOperation): string[] | undefined {
  switch (operation.kind) {
    case "swap":
    case "insert_before":
    case "insert_after":
    case "insert_head":
    case "insert_tail":
      return operation.lines;
    default:
      return undefined;
  }
}

export class PatchSection {
  readonly path: string;
  readonly fileHash: string;
  readonly operations: readonly HashlineOperation[];
  readonly warnings: readonly string[];

  constructor(data: ParsedSectionData) {
    this.path = data.path;
    this.fileHash = data.fileHash;
    this.operations = data.operations;
    this.warnings = data.warnings;
  }

  collectAnchorLines(): readonly number[] {
    const lines = new Set<number>();
    for (const operation of this.operations) {
      switch (operation.kind) {
        case "swap":
        case "delete":
          for (let line = operation.startLine; line <= operation.endLine; line++) lines.add(line);
          break;
        case "insert_before":
        case "insert_after":
          lines.add(operation.anchorLine);
          break;
        default:
          break;
      }
    }
    return [...lines].sort((a, b) => a - b);
  }
}

export class Patch {
  readonly sections: readonly PatchSection[];

  private constructor(sections: PatchSection[]) {
    this.sections = sections;
  }

  static parse(input: string, _options: ParseOptions = {}): Patch {
    const lines = normalizeInput(input).split("\n");
    const sections: PatchSection[] = [];
    let currentPath: string | undefined;
    let currentHash: string | undefined;
    let currentOperations: HashlineOperation[] = [];
    let pending: PendingOperation | undefined;

    const flushPending = (): void => {
      if (!pending) return;
      if (pending.expectsBody) {
        const body = operationBody(pending.operation)!;
        if (body.length === 0) {
          throw new Error(`line ${pending.operation.sourceLine}: ${pending.operation.kind === "swap" ? "SWAP" : "INS.*"} requires at least one body row.`);
        }
      }
      currentOperations.push(pending.operation);
      pending = undefined;
    };

    const flushSection = (): void => {
      flushPending();
      if (currentPath === undefined || currentHash === undefined) return;
      if (currentOperations.length === 0) {
        throw new Error(`Section ${HL_FILE_PREFIX}${currentPath}${HL_FILE_HASH_SEP}${currentHash}${HL_FILE_SUFFIX} has no operations.`);
      }
      sections.push(new PatchSection({ path: currentPath, fileHash: currentHash, operations: currentOperations, warnings: [] }));
      currentPath = undefined;
      currentHash = undefined;
      currentOperations = [];
    };

    for (let index = 0; index < lines.length; index++) {
      const lineNumber = index + 1;
      const rawLine = lines[index] ?? "";
      const header = parseHeader(rawLine, lineNumber);
      if (header) {
        flushSection();
        currentPath = header.path;
        currentHash = header.fileHash;
        currentOperations = [];
        continue;
      }

      if (pending) {
        const nestedOperation = parseOperation(rawLine, lineNumber);
        if (nestedOperation) {
          flushPending();
          pending = nestedOperation;
          continue;
        }
        if (rawLine.length === 0) {
          throw new Error(`line ${lineNumber}: ${BLANK_BODY_ROW_MESSAGE}`);
        }
        if (!rawLine.startsWith(HL_PAYLOAD_PREFIX)) {
          throw new Error(`line ${lineNumber}: ${BODY_ROWS_REQUIRE_PLUS_MESSAGE}`);
        }
        operationBody(pending.operation)!.push(rawLine.slice(1));
        continue;
      }

      if (rawLine.trim().length === 0) continue;
      if (currentPath === undefined) {
        throw new Error(`line ${lineNumber}: patch input must start with ${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}${"A1B2"}${HL_FILE_SUFFIX}.`);
      }
      const operation = parseOperation(rawLine, lineNumber);
      if (!operation) {
        throw new Error(`line ${lineNumber}: unrecognized hashline operation. Use explicit SWAP / DEL / INS.PRE / INS.POST / INS.HEAD / INS.TAIL forms.`);
      }
      pending = operation;
    }

    flushSection();
    if (pending) flushPending();
    if (sections.length === 0) throw new Error(`patch input must start with ${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}${"A1B2"}${HL_FILE_SUFFIX}.`);

    const seenPaths = new Set<string>();
    for (const section of sections) {
      if (seenPaths.has(section.path)) {
        throw new Error(`Patch contains multiple sections for ${section.path}. Use one ${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}TAG${HL_FILE_SUFFIX} header per file and place all hunks under it.`);
      }
      seenPaths.add(section.path);
    }

    return new Patch(sections);
  }

  static parseSingle(input: string, options: ParseOptions = {}): PatchSection {
    const patch = Patch.parse(input, options);
    const [section] = patch.sections;
    if (!section) throw new Error("Patch input did not produce any sections.");
    return section;
  }
}
