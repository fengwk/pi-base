import { HL_FILE_HASH_SEP } from "./format.js";
import { formatAnchoredContext } from "./messages.js";

export interface MismatchDetails {
  path?: string;
  expectedFileHash: string;
  actualFileHash: string;
  fileLines: string[];
  anchorLines?: readonly number[];
  hashRecognized?: boolean;
}

export class MismatchError extends Error {
  readonly path: string | undefined;
  readonly expectedFileHash: string;
  readonly actualFileHash: string;
  readonly fileLines: string[];
  readonly anchorLines: readonly number[];
  readonly hashRecognized: boolean;

  constructor(details: MismatchDetails) {
    super(MismatchError.formatMessage(details));
    this.name = "MismatchError";
    this.path = details.path;
    this.expectedFileHash = details.expectedFileHash;
    this.actualFileHash = details.actualFileHash;
    this.fileLines = details.fileLines;
    this.anchorLines = details.anchorLines ?? [];
    this.hashRecognized = details.hashRecognized ?? true;
  }

  get displayMessage(): string {
    return MismatchError.formatMessage(this);
  }

  static formatMessage(details: MismatchDetails): string {
    const pathSuffix = details.path ? ` for ${details.path}` : "";
    const header = details.hashRecognized ?? true
      ? [
          `Edit rejected${pathSuffix}: file changed between read and edit.`,
          `Section is bound to ${HL_FILE_HASH_SEP}${details.expectedFileHash}, but the current file hashes to ${HL_FILE_HASH_SEP}${details.actualFileHash}. Re-read the file and copy the fresh header before retrying.`,
        ]
      : [
          `Edit rejected${pathSuffix}: hash ${HL_FILE_HASH_SEP}${details.expectedFileHash} is not from this session.`,
          `The current file hashes to ${HL_FILE_HASH_SEP}${details.actualFileHash}. Re-read the file and copy a current header; never invent a tag and never reuse one from a prior session.`,
        ];
    const context = formatAnchoredContext(details.anchorLines ?? [], details.fileLines);
    return context.length === 0 ? header.join("\n") : [...header, "", ...context].join("\n");
  }
}
