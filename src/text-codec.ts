import { isUtf8 } from "node:buffer";
import iconv from "iconv-lite";
import { detect as detectEncodingCandidate } from "jschardet";
import { looksLikeBinary, looksLikeDecodedBinaryText } from "./binary-detect.js";

export type TextBomKind = "none" | "utf-8" | "utf-16le" | "utf-16be" | "utf-32le" | "utf-32be";
export type TextEncodingDetectionSource = "bom" | "declaration" | "utf8" | "utf16-heuristic" | "detector" | "default";

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

/** Only recognize standard file headers, never arbitrary encoding-like strings in source code. */
export function detectDeclaredTextEncoding(text: string): string | undefined {
  const header = text.slice(0, 4096);
  const xml = /^<\?xml\s[^?]*\bencoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\1[^?]*\?>/.exec(header);
  const css = /^@charset\s+"([A-Za-z][A-Za-z0-9._-]*)"\s*;/.exec(header);
  const lines = header.split(/\r\n|\r|\n/, 2);
  const cookie = /^[ \t\f]*#.*?\bcoding[:=][ \t]*([-\w.]+)/;
  const python = cookie.exec(lines[0] ?? "")
    ?? (/^[ \t\f]*(?:#.*)?$/.test(lines[0] ?? "") ? cookie.exec(lines[1] ?? "") : null);
  let name = xml?.[2] ?? css?.[1] ?? python?.[1];
  if (!name) {
    // HTML declarations belong in the initial head, not comments, scripts, body text or JS strings.
    const html = header.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, "");
    if (/^\s*(?:<!doctype\s+html\b[^>]*>\s*)?<(?:html|head|meta)\b/i.test(html)) {
      const head = html.split(/<\/head\s*>|<body\b/i, 1)[0]!;
      for (const meta of head.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
        const attributes = new Map<string, string>();
        for (const attr of meta[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
          attributes.set(attr[1]!.toLowerCase(), attr[2] ?? attr[3] ?? attr[4]!);
        }
        name = attributes.get("charset");
        if (!name && attributes.get("http-equiv")?.toLowerCase() === "content-type") {
          name = /\bcharset\s*=\s*["']?([-\w.]+)/i.exec(attributes.get("content") ?? "")?.[1];
        }
        if (name) break;
      }
    }
  }
  if (!name) return undefined;
  // Statistical ASCII is compatible with UTF-8, but an explicit ASCII declaration is a real restriction.
  const encoding = normalizeEncodingName(name.toUpperCase() === "ASCII" ? "us-ascii" : name);
  if (!encoding) throw new Error(`Unsupported declared text encoding: ${name}.`);
  return encoding;
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

  const declared = detectDeclaredTextEncoding(buffer.subarray(0, 4096).toString("latin1"));
  if (declared) return { encoding: declared, bom: "none", source: "declaration" };

  // Valid UTF-8 (including ASCII) needs no statistical guess. Keep NUL-bearing
  // data on the UTF-16/binary path rather than treating it as ordinary UTF-8.
  if (!buffer.includes(0) && isUtf8(buffer)) return { encoding: DEFAULT_TEXT_ENCODING, bom: "none", source: "utf8" };

  const utf16 = detectUtf16WithoutBom(buffer);
  if (utf16) return { encoding: utf16, bom: "none", source: "utf16-heuristic" };

  const detected = detectEncodingCandidate(buffer);
  const normalized = normalizeEncodingName(detected.encoding);
  if (normalized) return { encoding: normalized, bom: "none", source: "detector" };

  return { encoding: DEFAULT_TEXT_ENCODING, bom: "none", source: "default" };
}

export function decodeTextFile(buffer: Buffer): DecodedTextFile | null {
  if (buffer.length === 0) {
    return { encoding: DEFAULT_TEXT_ENCODING, bom: "none", source: "utf8", text: "" };
  }

  const detected = detectTextFileEncoding(buffer);
  if (detected.source !== "bom" && detected.source !== "utf16-heuristic" && buffer.includes(0)) return null;
  if (detected.source === "default" && looksLikeBinary(buffer)) return null;

  const text = decodeWithEncoding(buffer, detected);
  if (detected.source === "bom" || detected.source === "declaration" || detected.source === "utf8" || !looksLikeDecodedBinaryText(text)) {
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

/** A successful text round-trip alone cannot detect bytes lost while decoding the original. */
export function assertOriginalBytesRoundTrip(buffer: Buffer, decoded: DecodedTextFile): void {
  try {
    if (encodeTextFile(decoded.text, decoded.encoding, decoded.bom).equals(buffer)) return;
  } catch {
    // An unencodable original is just as unsafe as one that re-encodes to different bytes.
  }
  throw new Error(`Cannot preserve original bytes with encoding ${decoded.encoding}. The file may contain invalid bytes or have been decoded incorrectly; refusing to rewrite it.`);
}

export function textStartsWithBomMarker(text: string): boolean {
  return text.startsWith(LEADING_BOM_CHAR);
}

export function defaultTextEncoding(): string {
  return DEFAULT_TEXT_ENCODING;
}
