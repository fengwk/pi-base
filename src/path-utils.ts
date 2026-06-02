import * as os from "os";
import { isAbsolute, resolve as resolvePath } from "path";

function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function expandPath(filePath: string): string {
	const normalized = normalizeAtPrefix(filePath);
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1);
	return normalized;
}

export function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}
