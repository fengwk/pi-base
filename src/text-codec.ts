import { isUtf8 } from "node:buffer";
import iconv from "iconv-lite";

export type TextBomKind = "none" | "utf-8" | "utf-16le" | "utf-16be" | "utf-32le" | "utf-32be";

export interface TextEncoding {
  /** Canonical display name: every label that resolves to this encoding reports it. */
  name: string;
  /** iconv-lite codec name used for decoding and encoding. */
  codec: string;
}

export interface DecodedTextFile {
  text: string;
  encoding: TextEncoding;
  bom: TextBomKind;
}

/** The bytes are binary: a NUL byte, or a NUL character after a UTF-16/32 BOM. */
export class BinaryFileError extends Error {
  constructor() {
    super("The content is binary (it contains NUL bytes).");
    this.name = "BinaryFileError";
  }
}

/** No declaration and the bytes are not valid UTF-8. */
export class UnknownTextEncodingError extends Error {
  constructor() {
    super("The content is not valid UTF-8 and declares no text encoding.");
    this.name = "UnknownTextEncodingError";
  }
}

/** A declaration names a label that does not resolve. */
export class UnsupportedEncodingLabelError extends Error {
  readonly label: string;
  readonly where: string;

  constructor(label: string, where: string) {
    super(`Unsupported declared text encoding "${label}" (${where}).`);
    this.name = "UnsupportedEncodingLabelError";
    this.label = label;
    this.where = where;
  }
}

/** The declared encoding and the bytes cannot both be right. */
export class EncodingDeclarationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodingDeclarationConflictError";
  }
}

/** The bytes do not decode exactly with the chosen encoding. */
export class UndecodableTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndecodableTextError";
  }
}

/** The text contains a character the chosen encoding cannot represent. */
export class UnrepresentableTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrepresentableTextError";
  }
}

const UTF8: TextEncoding = { name: "UTF-8", codec: "utf-8" };
const ASCII: TextEncoding = { name: "US-ASCII", codec: "us-ascii" };
const UTF16LE: TextEncoding = { name: "UTF-16LE", codec: "utf-16le" };
const UTF16BE: TextEncoding = { name: "UTF-16BE", codec: "utf-16be" };
const UTF32LE: TextEncoding = { name: "UTF-32LE", codec: "utf-32le" };
const UTF32BE: TextEncoding = { name: "UTF-32BE", codec: "utf-32be" };
const ISO_8859_1: TextEncoding = { name: "ISO-8859-1", codec: "latin1" };

const LEADING_BOM_CHAR = "\uFEFF";
/** Git's binary rule: a NUL byte in this prefix marks the content as binary. */
export const BINARY_PROBE_BYTES = 8000;
/** HTML meta and JSP page directives are only honored inside this prefix. */
const SHORT_DECLARATION_BYTES = 1024;
/** Line-based declarations are only honored inside this prefix. */
const LONG_DECLARATION_BYTES = 4096;

interface BomSpec {
  bom: Exclude<TextBomKind, "none">;
  bytes: readonly number[];
  encoding: TextEncoding;
}

/** Ordered so the UTF-32LE mark wins over the UTF-16LE prefix it starts with. */
const BOM_SPECS: readonly BomSpec[] = [
  { bom: "utf-32le", bytes: [0xff, 0xfe, 0x00, 0x00], encoding: UTF32LE },
  { bom: "utf-32be", bytes: [0x00, 0x00, 0xfe, 0xff], encoding: UTF32BE },
  { bom: "utf-8", bytes: [0xef, 0xbb, 0xbf], encoding: UTF8 },
  { bom: "utf-16le", bytes: [0xff, 0xfe], encoding: UTF16LE },
  { bom: "utf-16be", bytes: [0xfe, 0xff], encoding: UTF16BE },
];

type DeclarationSource = "xml" | "css" | "html" | "python" | "ruby" | "jsp";

interface DeclaredLabel {
  label: string;
  where: string;
  source: DeclarationSource;
}

/** Labels whose canonical name and codec are shared by every declaration source. */
const CANONICAL_ENCODINGS: Readonly<Record<string, TextEncoding>> = {
  "utf-8": UTF8,
  utf8: UTF8,
  "us-ascii": ASCII,
  ascii: ASCII,
  "utf-16le": UTF16LE,
  utf16le: UTF16LE,
  "utf-16be": UTF16BE,
  utf16be: UTF16BE,
  "utf-32le": UTF32LE,
  utf32le: UTF32LE,
  "utf-32be": UTF32BE,
  utf32be: UTF32BE,
  latin1: ISO_8859_1,
  "latin-1": ISO_8859_1,
  "iso-8859-1": ISO_8859_1,
  "iso8859-1": ISO_8859_1,
  "windows-1252": { name: "windows-1252", codec: "windows-1252" },
  cp1252: { name: "windows-1252", codec: "windows-1252" },
  // iconv-lite's GB2312 alias is the GBK superset, matching the Encoding Standard.
  gb2312: { name: "GBK", codec: "gbk" },
  gbk: { name: "GBK", codec: "gbk" },
  cp936: { name: "GBK", codec: "gbk" },
  ms936: { name: "GBK", codec: "gbk" },
  gb18030: { name: "GB18030", codec: "gb18030" },
  big5: { name: "Big5", codec: "big5" },
  "big5-hkscs": { name: "Big5", codec: "big5" },
  cp950: { name: "Big5", codec: "big5" },
  shift_jis: { name: "Shift_JIS", codec: "shift_jis" },
  "shift-jis": { name: "Shift_JIS", codec: "shift_jis" },
  sjis: { name: "Shift_JIS", codec: "shift_jis" },
  "x-sjis": { name: "Shift_JIS", codec: "shift_jis" },
  ms_kanji: { name: "Shift_JIS", codec: "shift_jis" },
  "windows-31j": { name: "Shift_JIS", codec: "shift_jis" },
  cp932: { name: "Shift_JIS", codec: "shift_jis" },
  "euc-kr": { name: "EUC-KR", codec: "euc-kr" },
  euckr: { name: "EUC-KR", codec: "euc-kr" },
  "ks_c_5601-1987": { name: "EUC-KR", codec: "euc-kr" },
  cp949: { name: "EUC-KR", codec: "euc-kr" },
  "windows-949": { name: "EUC-KR", codec: "euc-kr" },
};

/** PEP 263 coding comment pattern, without a word boundary before `coding`. */
const CODING_COMMENT_RE = /^[ \t\f]*#.*?coding[:=][ \t]*([-_.a-zA-Z0-9]+)/;

function startsWithBytes(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  for (let index = 0; index < bytes.length; index++) {
    if (buffer[index] !== bytes[index]) return false;
  }
  return true;
}

function detectBom(buffer: Buffer): BomSpec | null {
  return BOM_SPECS.find((spec) => startsWithBytes(buffer, spec.bytes)) ?? null;
}

function bomBytes(bom: TextBomKind): Buffer {
  const spec = BOM_SPECS.find((candidate) => candidate.bom === bom);
  return spec ? Buffer.from(spec.bytes) : Buffer.alloc(0);
}

function fileExtension(filePath: string): string {
  const name = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * CPython's `get_normal_name`, applied to Python and Ruby coding comments so
 * `utf-8-unix` keeps its meaning and `latin-1` stays true Latin-1.
 */
function pythonNormalizedName(raw: string): string {
  const candidate = raw.slice(0, 12).toLowerCase().replace(/_/g, "-");
  if (candidate === "utf-8" || candidate.startsWith("utf-8-")) return "utf-8";
  for (const prefix of ["latin-1", "iso-8859-1", "iso-latin-1"]) {
    if (candidate === prefix || candidate.startsWith(`${prefix}-`)) return "iso-8859-1";
  }
  return raw;
}

function canonicalEncodingFor(label: string): TextEncoding | undefined {
  return CANONICAL_ENCODINGS[label.trim().toLowerCase()];
}

/** WHATWG's own canonical name keeps display names stable for labels outside the table. */
function whatwgEncodingName(label: string): string | undefined {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return undefined;
  }
}

/** IANA lookup through iconv-lite's own names; `latin1` and friends stay true Latin-1. */
function resolveIanaLabel(label: string): TextEncoding | undefined {
  const canonical = canonicalEncodingFor(label);
  if (canonical) return canonical;
  if (!iconv.encodingExists(label)) return undefined;
  const whatwgName = whatwgEncodingName(label);
  if (whatwgName) return canonicalEncodingFor(whatwgName) ?? { name: whatwgName, codec: label };
  return { name: label.trim().toLowerCase(), codec: label };
}

/** WHATWG lookup through TextDecoder, so `gb2312` and `iso-8859-1` follow the Encoding Standard. */
function resolveWhatwgLabel(label: string): TextEncoding | undefined {
  const whatwgName = whatwgEncodingName(label);
  if (!whatwgName) return undefined;
  const canonical = canonicalEncodingFor(whatwgName);
  if (canonical) return canonical;
  return iconv.encodingExists(whatwgName) ? { name: whatwgName, codec: whatwgName } : undefined;
}

function resolveLabel(label: string, source: DeclarationSource): TextEncoding | undefined {
  const prepared = source === "python" || source === "ruby" ? pythonNormalizedName(label) : label.trim();
  if (/^utf[-_]?8$/i.test(prepared)) return UTF8;
  if (/^(?:us[-_]?)?ascii$/i.test(prepared)) return ASCII;
  if (source === "html" || source === "css") return resolveWhatwgLabel(prepared);
  return resolveIanaLabel(prepared) ?? resolveWhatwgLabel(prepared);
}

function resolveDeclaredLabel(declared: DeclaredLabel, bom: TextBomKind): TextEncoding {
  const label = declared.label.trim();
  if (/^utf[-_]?16$/i.test(label) || /^utf[-_]?32$/i.test(label)) {
    if (bom === "none") {
      throw new EncodingDeclarationConflictError(
        `Declared text encoding ${label.toUpperCase()} ${declared.where}, but the file has no byte order mark.`,
      );
    }
    return BOM_SPECS.find((spec) => spec.bom === bom)!.encoding;
  }
  const encoding = resolveLabel(label, declared.source);
  if (!encoding) throw new UnsupportedEncodingLabelError(label, declared.where);
  // A byte order mark is authoritative, so a declaration beside it must agree.
  const bomSpec = BOM_SPECS.find((spec) => spec.bom === bom);
  if (bomSpec && bomSpec.encoding.name !== encoding.name) {
    throw new EncodingDeclarationConflictError(
      `Declared text encoding ${encoding.name} ${declared.where}, but the byte order mark is ${bomSpec.encoding.name}.`,
    );
  }
  return encoding;
}

/** WHATWG HTML prescan: `<meta charset>` or `http-equiv="Content-Type"`, ignoring hidden regions. */
function detectHtmlLabel(probe: string): string | undefined {
  const cleaned = probe
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
  const headEnd = cleaned.search(/<\/head\s*>|<body\b/i);
  const head = headEnd < 0 ? cleaned : cleaned.slice(0, headEnd);
  for (const meta of head.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attributes = new Map<string, string>();
    for (const attribute of meta[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
      attributes.set(attribute[1]!.toLowerCase(), (attribute[2] ?? attribute[3] ?? attribute[4] ?? "").trim());
    }
    const charset = attributes.get("charset");
    if (charset) return charset;
    if (attributes.get("http-equiv")?.toLowerCase() === "content-type") {
      const contentType = /\bcharset\s*=\s*["']?([-\w.]+)/i.exec(attributes.get("content") ?? "");
      if (contentType) return contentType[1];
    }
  }
  return undefined;
}

/** JSP `pageEncoding`, or `charset` inside `contentType`, of a page directive in the first 1024 bytes. */
function detectJspLabel(probe: string): string | undefined {
  for (const directive of probe.matchAll(/<%@\s*page\b([\s\S]*?)%>/gi)) {
    const body = directive[1] ?? "";
    const pageEncoding = /\bpageEncoding\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(body);
    if (pageEncoding) return (pageEncoding[1] ?? pageEncoding[2] ?? "").trim();
    const contentType = /\bcontentType\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(body);
    const charset = /\bcharset\s*=\s*([-\w.]+)/i.exec(contentType?.[1] ?? contentType?.[2] ?? "");
    if (charset) return charset[1];
  }
  return undefined;
}

function cookieDeclaration(probe: string, source: "python" | "ruby"): DeclaredLabel | undefined {
  const [first = "", second = ""] = probe.split(/\r\n|\r|\n/, 2);
  const firstMatch = CODING_COMMENT_RE.exec(first);
  if (firstMatch) return { label: firstMatch[1]!, where: `on line 1 of the ${source === "python" ? "Python" : "Ruby"} source`, source };
  const secondReadable = source === "python"
    // PEP 263 also reads line 2 when line 1 is blank, whitespace, or a comment.
    ? /^[ \t\f]*(?:#.*)?$/.test(first)
    : first.startsWith("#!");
  if (!secondReadable) return undefined;
  const secondMatch = CODING_COMMENT_RE.exec(second);
  return secondMatch
    ? { label: secondMatch[1]!, where: `on line 2 of the ${source === "python" ? "Python" : "Ruby"} source`, source }
    : undefined;
}

function detectDeclaredLabel(probe: string, filePath: string): DeclaredLabel | undefined {
  // A leading U+FEFF in new content is a byte order mark request, not content.
  const text = probe.startsWith(LEADING_BOM_CHAR) ? probe.slice(1) : probe;
  const xml = /^<\?xml\s[^?]*\bencoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\1[^?]*\?>/.exec(text);
  if (xml) return { label: xml[2]!, where: "in the XML declaration", source: "xml" };
  const css = /^@charset "([A-Za-z][A-Za-z0-9._-]*)";/.exec(text);
  if (css) return { label: css[1]!, where: "in the @charset rule", source: "css" };
  const extension = fileExtension(filePath);
  if (extension === "html" || extension === "htm") {
    const label = detectHtmlLabel(text.slice(0, SHORT_DECLARATION_BYTES));
    return label ? { label, where: "in the HTML head", source: "html" } : undefined;
  }
  if (extension === "jsp" || extension === "jspf" || extension === "tag") {
    const label = detectJspLabel(text.slice(0, SHORT_DECLARATION_BYTES));
    return label ? { label, where: "in the JSP page directive", source: "jsp" } : undefined;
  }
  if (extension === "py" || extension === "pyw" || extension === "pyi") return cookieDeclaration(text, "python");
  if (extension === "rb") return cookieDeclaration(text, "ruby");
  return undefined;
}

/** Byte-preserving Latin-1 view: declarations are ASCII, so no earlier byte is reinterpreted. */
function declarationProbe(buffer: Buffer): string {
  return buffer.subarray(0, LONG_DECLARATION_BYTES).toString("latin1");
}

function findFirstDifference(original: Buffer, reencoded: Buffer): number {
  const limit = Math.min(original.length, reencoded.length);
  let offset = 0;
  while (offset < limit && original[offset] === reencoded[offset]) offset++;
  return offset;
}

function decodeExact(buffer: Buffer, encoding: TextEncoding): string {
  if (encoding.name === "UTF-8") {
    if (!isUtf8(buffer)) throw new UndecodableTextError("The content is not valid UTF-8.");
    return buffer.toString("utf8");
  }
  if (encoding.name === "US-ASCII") {
    const invalid = buffer.findIndex((byte) => byte >= 0x80);
    if (invalid >= 0) {
      throw new UndecodableTextError(
        `The content is not valid US-ASCII (byte 0x${buffer[invalid]!.toString(16)} at offset ${invalid}).`,
      );
    }
    return buffer.toString("latin1");
  }
  const text = iconv.decode(buffer, encoding.codec, { stripBOM: false });
  const reencoded = iconv.encode(text, encoding.codec, { addBOM: false });
  if (!reencoded.equals(buffer)) {
    throw new UndecodableTextError(
      `The content does not decode losslessly as ${encoding.name} (first difference at offset ${findFirstDifference(buffer, reencoded)}).`,
    );
  }
  return text;
}

function hasNulByte(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

function hasNonAsciiByte(buffer: Buffer): boolean {
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index]! >= 0x80) return true;
  }
  return false;
}

function assertDeclarationMatchesBytes(buffer: Buffer, encoding: TextEncoding, declared: DeclaredLabel): void {
  // UTF-8 and ASCII declarations describe exactly what the decoder verifies.
  if (encoding.name === "UTF-8" || encoding.name === "US-ASCII") return;
  if (!isUtf8(buffer)) return;
  // The whole file decides: a declaration over later non-ASCII UTF-8 is still a conflict.
  if (!hasNonAsciiByte(buffer)) return;
  throw new EncodingDeclarationConflictError(
    `Declared text encoding ${encoding.name} ${declared.where}, but the content is valid UTF-8 with non-ASCII characters.`,
  );
}

/**
 * The binary rule for a BOM-marked file judges the characters decoded from the
 * first 8000 body bytes; the decoded text itself may legitimately contain NUL later.
 */
function decodeBinaryProbe(body: Buffer, bom: BomSpec): string {
  return iconv.decode(body.subarray(0, Math.min(body.length, BINARY_PROBE_BYTES)), bom.encoding.codec, { stripBOM: false });
}

/**
 * Decodes text with the deterministic codec: BOM, then a standard declaration,
 * then validated UTF-8. It never guesses. `filePath` selects the file-extension
 * declaration forms (HTML, JSP, Python, Ruby).
 */
export function decodeTextFile(buffer: Buffer, filePath = ""): DecodedTextFile {
  const bom = detectBom(buffer);
  if (bom) {
    const body = buffer.subarray(bom.bytes.length);
    // A BOM-marked UTF-16/32 file always contains NUL bytes, so judge its characters.
    if (decodeBinaryProbe(body, bom).includes("\u0000")) throw new BinaryFileError();
    return { text: decodeExact(body, bom.encoding), encoding: bom.encoding, bom: bom.bom };
  }
  if (hasNulByte(buffer)) throw new BinaryFileError();
  const declared = detectDeclaredLabel(declarationProbe(buffer), filePath);
  if (declared) {
    const encoding = resolveDeclaredLabel(declared, "none");
    assertDeclarationMatchesBytes(buffer, encoding, declared);
    return { text: decodeExact(buffer, encoding), encoding, bom: "none" };
  }
  if (!isUtf8(buffer)) throw new UnknownTextEncodingError();
  return { text: buffer.toString("utf8"), encoding: UTF8, bom: "none" };
}

/**
 * Resolves the encoding that a declaration in `text` selects. `bom` is the
 * byte order mark the file carries (or will carry), so generic UTF-16/32
 * labels resolve against it and a BOM-less declaration is a conflict.
 */
export function resolveDeclaredEncoding(text: string, filePath: string, bom: TextBomKind): TextEncoding | undefined {
  const declared = detectDeclaredLabel(text.slice(0, LONG_DECLARATION_BYTES), filePath);
  return declared ? resolveDeclaredLabel(declared, bom) : undefined;
}

/**
 * Resolves how a whole-file rewrite encodes its content: the declaration inside
 * the new text decides, and a leading U+FEFF asks for that encoding's byte order
 * mark. Text without a declaration is written as UTF-8.
 */
export function resolveContentEncoding(text: string, filePath: string): { encoding: TextEncoding; bom: TextBomKind } {
  const declared = detectDeclaredLabel(text.slice(0, LONG_DECLARATION_BYTES), filePath);
  const encoding = declared ? resolveContentLabel(declared) : UTF8;
  if (!text.startsWith(LEADING_BOM_CHAR)) return { encoding, bom: "none" };
  const bom = bomKindForEncoding(encoding);
  if (bom === "none") {
    throw new EncodingDeclarationConflictError(
      `The leading U+FEFF requests a byte order mark, but ${encoding.name} ${declared ? "has none" : "is written without one"}.`,
    );
  }
  return { encoding, bom };
}

/** A generic UTF-16/32 label names the byte order mark family; the output uses the LE member. */
function resolveContentLabel(declared: DeclaredLabel): TextEncoding {
  const label = declared.label.trim();
  if (/^utf[-_]?16$/i.test(label)) return UTF16LE;
  if (/^utf[-_]?32$/i.test(label)) return UTF32LE;
  if (/^utf[-_]?(16|32)(le|be)$/i.test(label)) {
    throw new EncodingDeclarationConflictError(
      `Declared text encoding ${label.toUpperCase()} ${declared.where}, but the content has no byte order mark. Start the content with U+FEFF to write it with a byte order mark.`,
    );
  }
  const encoding = resolveLabel(label, declared.source);
  if (!encoding) throw new UnsupportedEncodingLabelError(label, declared.where);
  return encoding;
}

export function encodingForBom(bom: TextBomKind): TextEncoding | undefined {
  return BOM_SPECS.find((spec) => spec.bom === bom)?.encoding;
}

/** Git's binary rule on a file prefix; a BOM opens a text file judged by its decoded characters. */
export function looksLikeBinary(buffer: Buffer): boolean {
  return detectBom(buffer) === null && hasNulByte(buffer);
}

/** The user-facing reason a tool could not use a text file, with the path it affects. */
export function formatTextFileError(error: unknown, displayPath: string, action: string): string {
  if (error instanceof BinaryFileError) return `${displayPath} is a binary file (it contains NUL bytes).`;
  if (error instanceof UnknownTextEncodingError) {
    return `${displayPath} is not UTF-8 text and declares no encoding, so it was not ${action}. `
      + `If you know its encoding, view it with bash, for example iconv -f GBK -t UTF-8 '${displayPath}'. `
      + "To use read, edit or write on it, convert it to UTF-8 or add a standard encoding declaration.";
  }
  return `${displayPath}: ${(error as Error).message}`;
}

export function bomKindForEncoding(encoding: TextEncoding): TextBomKind {
  return BOM_SPECS.find((spec) => spec.encoding.name === encoding.name)?.bom ?? "none";
}

function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) index++;
      line++;
    } else if (code === 10) {
      line++;
    }
  }
  return line;
}

function describeUnrepresentable(encoding: TextEncoding, character: string, text: string, offset: number): UnrepresentableTextError {
  const hex = (character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
  return new UnrepresentableTextError(
    `The new text cannot be encoded in ${encoding.name}: "${character}" (U+${hex}) on line ${lineOfOffset(text, offset)}.`,
  );
}

function encodeExact(text: string, encoding: TextEncoding): Buffer {
  if (encoding.name === "UTF-8") return Buffer.from(text, "utf8");
  if (encoding.name === "US-ASCII") {
    for (let offset = 0; offset < text.length; ) {
      const character = String.fromCodePoint(text.codePointAt(offset)!);
      if (character.codePointAt(0)! > 0x7f) throw describeUnrepresentable(encoding, character, text, offset);
      offset += character.length;
    }
    return Buffer.from(text, "ascii");
  }
  const bytes = iconv.encode(text, encoding.codec, { addBOM: false });
  if (iconv.decode(bytes, encoding.codec, { stripBOM: false }) === text) return bytes;
  for (let offset = 0; offset < text.length; ) {
    const character = String.fromCodePoint(text.codePointAt(offset)!);
    if (iconv.decode(iconv.encode(character, encoding.codec), encoding.codec, { stripBOM: false }) !== character) {
      throw describeUnrepresentable(encoding, character, text, offset);
    }
    offset += character.length;
  }
  throw new UnrepresentableTextError(`The new text cannot be encoded in ${encoding.name}.`);
}

export function encodeTextFile(text: string, encoding: TextEncoding, bom: TextBomKind): Buffer {
  // A leading U+FEFF asks for a byte order mark; it is never part of the content.
  const body = text.startsWith(LEADING_BOM_CHAR) ? text.slice(1) : text;
  const bytes = encodeExact(body, encoding);
  const marker = bomBytes(bom);
  return marker.length === 0 ? bytes : Buffer.concat([marker, bytes]);
}
