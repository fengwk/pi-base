/** Core data types for pi-base's explicit-range hashline DSL. */

/** One parsed edit operation inside a `[path#TAG]` section. */
export type HashlineOperation =
  | {
      kind: "swap";
      startLine: number;
      endLine: number;
      lines: string[];
      sourceLine: number;
    }
  | {
      kind: "delete";
      startLine: number;
      endLine: number;
      sourceLine: number;
    }
  | {
      kind: "insert_before";
      anchorLine: number;
      lines: string[];
      sourceLine: number;
    }
  | {
      kind: "insert_after";
      anchorLine: number;
      lines: string[];
      sourceLine: number;
    }
  | {
      kind: "insert_head";
      lines: string[];
      sourceLine: number;
    }
  | {
      kind: "insert_tail";
      lines: string[];
      sourceLine: number;
    };

/** Result of applying one section's operations to normalized file text. */
export interface ApplyResult {
  text: string;
  firstChangedLine?: number;
  warnings?: string[];
}

/** Result of compacting a numbered diff preview for model-facing follow-up edits. */
export interface CompactDiffPreview {
  preview: string;
  addedLines: number;
  removedLines: number;
}

export interface CompactDiffOptions {
  maxAddedRunContext?: number;
  maxUnchangedRun?: number;
}

export interface EditRange {
  startLine: number;
  endLine: number;
}

/** Snapshot of one file section in a parsed patch. */
export interface ParsedSectionData {
  path: string;
  fileHash: string;
  operations: HashlineOperation[];
  warnings: string[];
}
