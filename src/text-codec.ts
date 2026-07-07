import iconv from "iconv-lite";
import { detect as detectEncodingCandidate } from "jschardet";
import { looksLikeBinary, looksLikeDecodedBinaryText } from "./binary-detect.js";

export type TextBomKind = "none" | "utf-8" | "utf-16le" | "utf-16be" | "utf-32le" | "utf-32be";
export type TextEncodingDetectionSource = "bom" | "utf16-heuristic" | "detector" | "default";

export interface DetectedTextEncoding {
  encoding: string;
  bom: TextBomKind;
  source: TextEncodingDetectionSource;
}

export interface DecodedTextFile extends DetectedTextEncoding {
  text: string;
}

const DEFAULT_TEXT_ENCODING = "utf-8";
const UTF16_ZERO_RATIO_THRESHOLD = 0.3;
const UTF16_OPPOSITE_ZERO_RATIO_MAX = 0.05;
const LEADING_BOM_CHAR = "\uFEFF";

interface BomDescriptor {
  bom: Exclude<TextBomKind, "none">;
  encoding: string;
  bytes: Buffer;
}

const BOM_DESCRIPTORS: readonly BomDescriptor[] = [
  { bom: "utf-8", encoding: "utf-8", bytes: Buffer.from([0xef, 0xbb, 0xbf]) },
  { bom: "utf-32le", encoding: "utf-32le", bytes: Buffer.from([0xff, 0xfe, 0x00, 0x00]) },
  { bom: "utf-32be", encoding: "utf-32be", bytes: Buffer.from([0x00, 0x00, 0xfe, 0xff]) },
  { bom: "utf-16le", encoding: "utf-16le", bytes: Buffer.from([0xff, 0xfe]) },
  { bom: "utf-16be", encoding: "utf-16be", bytes: Buffer.from([0xfe, 0xff]) },
] as const;

function stripLeadingBomChar(text: string): string {
  return text.startsWith(LEADING_BOM_CHAR) ? text.slice(1) : text;
}

function hasPrefix(buffer: Uint8Array, prefix: Uint8Array): boolean {
  if (buffer.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (buffer[index] !== prefix[index]) return false;
  }
  return true;
}

function detectBom(buffer: Uint8Array): BomDescriptor | null {
  for (const descriptor of BOM_DESCRIPTORS) {
    if (hasPrefix(buffer, descriptor.bytes)) return descriptor;
  }
  return null;
}

function detectUtf16WithoutBom(buffer: Uint8Array): "utf-16le" | "utf-16be" | null {
  if (buffer.length < 4 || buffer.length % 2 !== 0) return null;

  let evenZeroCount = 0;
  let oddZeroCount = 0;
  let evenCount = 0;
  let oddCount = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (index % 2 === 0) {
      evenCount++;
      if (buffer[index] === 0) evenZeroCount++;
      continue;
    }
    oddCount++;
    if (buffer[index] === 0) oddZeroCount++;
  }

  const evenRatio = evenCount === 0 ? 0 : evenZeroCount / evenCount;
  const oddRatio = oddCount === 0 ? 0 : oddZeroCount / oddCount;
  if (oddRatio >= UTF16_ZERO_RATIO_THRESHOLD && evenRatio <= UTF16_OPPOSITE_ZERO_RATIO_MAX) return "utf-16le";
  if (evenRatio >= UTF16_ZERO_RATIO_THRESHOLD && oddRatio <= UTF16_OPPOSITE_ZERO_RATIO_MAX) return "utf-16be";
  return null;
}

function normalizeEncodingName(name: string | null | undefined): string | null {
  if (!name) return null;

  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.toUpperCase() === "ASCII") return DEFAULT_TEXT_ENCODING;

  const candidates = new Set<string>([
    trimmed,
    trimmed.toLowerCase(),
    trimmed.toUpperCase(),
    trimmed.replace(/_/g, "-"),
    trimmed.toLowerCase().replace(/_/g, "-"),
  ]);

  for (const candidate of candidates) {
    if (!iconv.encodingExists(candidate)) continue;
    return candidate.toLowerCase();
  }
  return null;
}

function decodeWithEncoding(buffer: Buffer, detected: DetectedTextEncoding): string {
  const bom = detectBom(buffer);
  const bytes = bom && bom.bom === detected.bom ? buffer.subarray(bom.bytes.length) : buffer;
  return stripLeadingBomChar(iconv.decode(bytes, detected.encoding as any, { stripBOM: false }));
}

function getBomBytes(bom: TextBomKind): Buffer {
  if (bom === "none") return Buffer.alloc(0);
  return BOM_DESCRIPTORS.find((descriptor) => descriptor.bom === bom)?.bytes ?? Buffer.alloc(0);
}

export function bomKindForEncoding(encoding: string): TextBomKind {
  const normalized = normalizeEncodingName(encoding);
  if (normalized === "utf-8") return "utf-8";
  if (normalized === "utf-16le") return "utf-16le";
  if (normalized === "utf-16be") return "utf-16be";
  if (normalized === "utf-32le") return "utf-32le";
  if (normalized === "utf-32be") return "utf-32be";
  return "none";
}

export function detectTextFileEncoding(buffer: Buffer): DetectedTextEncoding {
  const bom = detectBom(buffer);
  if (bom) return { encoding: bom.encoding, bom: bom.bom, source: "bom" };

  const utf16 = detectUtf16WithoutBom(buffer);
  if (utf16) return { encoding: utf16, bom: "none", source: "utf16-heuristic" };

  const detected = detectEncodingCandidate(buffer, { minimumThreshold: 0 });
  const normalized = normalizeEncodingName(detected.encoding);
  if (normalized) return { encoding: normalized, bom: "none", source: "detector" };

  return { encoding: DEFAULT_TEXT_ENCODING, bom: "none", source: "default" };
}

export function decodeTextFile(buffer: Buffer): DecodedTextFile | null {
  if (buffer.length === 0) {
    return { encoding: DEFAULT_TEXT_ENCODING, bom: "none", source: "default", text: "" };
  }

  const detected = detectTextFileEncoding(buffer);
  if (detected.source === "default" && looksLikeBinary(buffer)) return null;

  const text = decodeWithEncoding(buffer, detected);
  if (detected.source === "bom" || !looksLikeDecodedBinaryText(text)) {
    return { ...detected, text };
  }

  if (looksLikeBinary(buffer)) return null;
  const fallback: DetectedTextEncoding = { encoding: DEFAULT_TEXT_ENCODING, bom: "none", source: "default" };
  return { ...fallback, text: decodeWithEncoding(buffer, fallback) };
}

export function encodeTextFile(text: string, encoding: string, bom: TextBomKind): Buffer {
  const normalized = normalizeEncodingName(encoding) ?? DEFAULT_TEXT_ENCODING;
  const bodyText = stripLeadingBomChar(text);
  const body = iconv.encode(bodyText, normalized as any, { addBOM: false });
  const roundTripText = stripLeadingBomChar(iconv.decode(body, normalized as any, { stripBOM: false }));
  if (roundTripText !== bodyText) {
    throw new Error(`Text cannot be represented in ${normalized} without data loss.`);
  }
  const bomBytes = getBomBytes(bom);
  return bomBytes.length === 0 ? body : Buffer.concat([bomBytes, body]);
}

export function textStartsWithBomMarker(text: string): boolean {
  return text.startsWith(LEADING_BOM_CHAR);
}

export function defaultTextEncoding(): string {
  return DEFAULT_TEXT_ENCODING;
}
