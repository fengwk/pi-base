import * as Diff from "diff";
import { formatHashlineDisplay } from "./hashline.js";

// ─── Line ending normalization ──────────────────────────────────────────

export type LineEndingStyle = "\r\n" | "\n" | "\r" | "mixed";

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

export function restoreLineEndings(text: string, ending: "\r\n" | "\n" | "\r"): string {
	if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
	if (ending === "\r") return text.replace(/\n/g, "\r");
	return text;
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

// ─── Diff generation ────────────────────────────────────────────────────

export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];
	const maxLineNum = Math.max(oldContent.split("\n").length, newContent.split("\n").length);
	const lineNumWidth = String(maxLineNum).length;
	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) firstChangedLine = newLineNum;
			for (const line of raw) {
				if (part.added) {
					output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
					newLineNum++;
				} else {
					output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextPartIsChange = i < parts.length - 1 && (parts[i + 1]!.added || parts[i + 1]!.removed);
		if (lastWasChange || nextPartIsChange) {
			let linesToShow = raw;
			let skipStart = 0;
			let skipEnd = 0;

			if (!lastWasChange) {
				skipStart = Math.max(0, raw.length - contextLines);
				linesToShow = raw.slice(skipStart);
			}
			if (!nextPartIsChange && linesToShow.length > contextLines) {
				skipEnd = linesToShow.length - contextLines;
				linesToShow = linesToShow.slice(0, contextLines);
			}

			if (skipStart > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipStart;
				newLineNum += skipStart;
			}
			for (const line of linesToShow) {
				output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
				oldLineNum++;
				newLineNum++;
			}
			if (skipEnd > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipEnd;
				newLineNum += skipEnd;
			}
		} else {
			oldLineNum += raw.length;
			newLineNum += raw.length;
		}
		lastWasChange = false;
	}

	return { diff: output.join("\n"), firstChangedLine };
}

/**
 * Generate a compact diff for single-line edits, or fall back to the full diff.
 *
 * - Single-line replacement: `LINE#HASH|old → LINE#HASH|new`
 * - Single-line deletion: `LINE#HASH|old → [deleted]`
 * - Multi-line changes: full output from generateDiffString()
 */
export function generateCompactOrFullDiff(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	if (oldContent === newContent) return { diff: "", firstChangedLine: undefined };

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const lineNumWidth = String(Math.max(oldLines.length, newLines.length)).length;

	// Case 1: Same line count, exactly one changed line → compact replacement.
	if (oldLines.length === newLines.length) {
		let changedIndex = -1;
		let changeCount = 0;

		for (let i = 0; i < oldLines.length; i++) {
			if (oldLines[i] !== newLines[i]) {
				changedIndex = i;
				changeCount++;
				if (changeCount > 1) break;
			}
		}

		if (changeCount === 1 && changedIndex >= 0) {
			const lineNum = changedIndex + 1;
			const oldLine = oldLines[changedIndex] ?? "";
			const newLine = newLines[changedIndex] ?? "";
			return {
				diff: [`- ${formatHashlineDisplay(lineNum, oldLine, lineNumWidth)}`, `+ ${formatHashlineDisplay(lineNum, newLine, lineNumWidth)}`].join("\n"),
				firstChangedLine: lineNum,
			};
		}
	}

	// Case 2: Exactly one line deleted.
	// old has one more line than new, and removing a single line makes them equal.
	if (oldLines.length === newLines.length + 1) {
		let deletedIndex = -1;
		let j = 0;
		let failed = false;

		for (let i = 0; i < oldLines.length; i++) {
			if (j < newLines.length && oldLines[i] === newLines[j]) {
				j++;
				continue;
			}
			if (deletedIndex === -1) {
				deletedIndex = i;
				continue;
			}
			failed = true;
			break;
		}

		if (!failed && deletedIndex !== -1 && j === newLines.length) {
			const lineNum = deletedIndex + 1;
			const oldLine = oldLines[deletedIndex] ?? "";
			return {
				diff: `- ${formatHashlineDisplay(lineNum, oldLine, lineNumWidth)}`,
				firstChangedLine: lineNum,
			};
		}
	}

	// Fall back to the full (existing) diff format.
	return generateDiffString(oldContent, newContent, contextLines);
}
