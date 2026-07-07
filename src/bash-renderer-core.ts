import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { DEFAULT_MAX_BYTES, formatSize, type BashToolOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveCollapsedResultLines, resolveCollapsedResultMaxChars, shortenHomePath, styleAccent, styleMuted, styleOutput, styleToolTitle, styleWarning, withLeadingResultNewline } from "./render.js";
import { describeToolWorkdirForDisplay, resolveToCwd } from "./path-utils.js";
import { loadToolPromptSnippet } from "./tool-prompt.js";

export type BashExecutionTool = { execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any> };
export type BashRenderDefinition = { renderResult?: (result: any, options: any, theme: any, context: any) => any };
export type BashFactory = (cwd: string) => BashExecutionTool;
export type BashDefinitionFactory = (cwd: string) => BashRenderDefinition;

export function formatBashCall(args: any, theme: any, cwd?: string): string {
  const rawCommand = args?.command;
  const command = typeof rawCommand === "string" ? rawCommand : "<missing-command>";
  const { rawWorkdir, usedDefault } = describeToolWorkdirForDisplay(args?.workdir, cwd);
  const workdir = usedDefault ? "" : `${styleMuted(theme, " in ")}${styleAccent(theme, shortenHomePath(rawWorkdir))}`;
  const timeoutSeconds = args?.timeout_seconds;
  const timeoutSuffix = timeoutSeconds ? styleMuted(theme, ` (timeout ${timeoutSeconds}s)`) : "";
  return `${styleToolTitle(theme, `$ ${command}`)}${timeoutSuffix}${workdir}`;
}

export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function extractBashText(result: any): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((item: any) => item?.type === "text")
    .map((item: any) => String(item.text ?? ""))
    .join("\n\n");
}

export function stripStructuredTruncationFooter(output: string, result: any, options: any): string {
  const truncation = result?.details?.truncation;
  const fullOutputPath = result?.details?.fullOutputPath;
  if (!options?.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
    const footerStart = output.lastIndexOf("\n\n[");
    if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
      return output.slice(0, footerStart).trimEnd();
    }
  }
  return output;
}

export function formatBashWarnings(result: any): string[] {
  const truncation = result?.details?.truncation;
  const fullOutputPath = result?.details?.fullOutputPath;
  const warnings: string[] = [];
  if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
  if (truncation?.truncated) {
    if (truncation.truncatedBy === "lines") {
      warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
    } else {
      warnings.push(`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`);
    }
  }
  return warnings;
}

export function formatBashResultText(result: any, options: any, theme: any, context: any, collapsedLines: number, maxCollapsedChars: number | undefined): string {
  const state = context?.state ?? {};
  let output = extractBashText(result).trim();
  output = stripStructuredTruncationFooter(output, result, options);

  const outputLines = output ? output.split("\n") : [];
  const collapsedOutput = options?.expanded
    ? output
    : collapsedLines === 0
      ? ""
      : outputLines.slice(-collapsedLines).join("\n");
  const wasLineTruncated = !options?.expanded && collapsedLines > 0 && outputLines.length > collapsedLines;
  const wasCharTruncated = !options?.expanded && typeof maxCollapsedChars === "number" && collapsedOutput.length > maxCollapsedChars;
  const visibleOutput = wasCharTruncated ? `${collapsedOutput.slice(0, maxCollapsedChars)}...` : collapsedOutput;
  const visibleLines = visibleOutput
    ? visibleOutput.split("\n").map((line) => styleOutput(theme, line))
    : [];
  const hiddenLineCount = !options?.expanded
    ? (collapsedLines === 0 ? outputLines.length : Math.max(0, outputLines.length - collapsedLines))
    : 0;
  const sections: string[] = [];

  if (!options?.expanded && (hiddenLineCount > 0 || wasCharTruncated)) {
    const details = [
      hiddenLineCount > 0 ? `${hiddenLineCount} earlier lines` : undefined,
      wasCharTruncated ? "output truncated" : undefined,
      "ctrl+o to expand",
    ].filter((part): part is string => Boolean(part));
    sections.push(styleMuted(theme, `... (${details.join(", ")})`));
  }
  if (visibleLines.length > 0) sections.push(...visibleLines);

  const warnings = formatBashWarnings(result);
  if (warnings.length > 0) {
    sections.push(styleWarning(theme, `[${warnings.join(". ")}]`));
  }

  if (state.startedAt !== undefined) {
    const label = options?.isPartial ? "Elapsed" : "Took";
    const endTime = state.endedAt ?? Date.now();
    sections.push(styleMuted(theme, `${label} ${formatDuration(endTime - state.startedAt)}`));
  }

  return sections.length > 0 ? sections.join("\n") : "";
}

function hostShellName(shellPath: string | undefined): string | undefined {
  if (!shellPath) return undefined;
  const name = basename(shellPath).toLowerCase();
  if (name === "bash" || name === "zsh") return name;
  return undefined;
}

export type RuntimePlatform = NodeJS.Platform | string;

export function detectOsLabelFrom(options: {
  platform: RuntimePlatform;
  env: Record<string, string | undefined>;
  readTextFile?: (path: string) => string | undefined;
}): string {
  const { platform, env, readTextFile } = options;
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform !== "linux") return platform;

  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "wsl";
  try {
    const procVersion = readTextFile?.("/proc/version")?.toLowerCase();
    if (procVersion?.includes("microsoft")) return "wsl";
  } catch {
    // ignore
  }
  try {
    const osRelease = readTextFile?.("/proc/sys/kernel/osrelease")?.toLowerCase();
    if (osRelease?.includes("microsoft")) return "wsl";
  } catch {
    // ignore
  }
  return "linux";
}

export function detectOsLabel(): string {
  return detectOsLabelFrom({
    platform: process.platform,
    env: process.env,
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
}

export function describeOsNoteFor(os: string): string {
  if (os === "wsl") {
    return "WSL environment. Windows files may be accessible under /mnt/<drive>, and some Windows commands may be invocable from WSL.";
  }
  if (os === "linux") return "Linux environment.";
  if (os === "macos") return "macOS environment.";
  if (os === "windows") return "Windows environment.";
  return `${os} environment.`;
}

function describeOsNote(): string {
  return describeOsNoteFor(detectOsLabel());
}

export function describeShellFor(options: { platform: RuntimePlatform; shellPath: string | undefined }): string {
  const { platform, shellPath } = options;
  const shellName = hostShellName(shellPath);
  if (shellName) return shellName;
  if (platform === "win32") return "platform-default";
  return "/bin/bash or sh fallback";
}

function describeShell(): string {
  return describeShellFor({ platform: process.platform, shellPath: process.env.SHELL });
}

export function loadBashDescription(): string {
  const template = readFileSync(new URL("../prompts/bash.md", import.meta.url), "utf8");
  return template
    .replaceAll("${os}", detectOsLabel())
    .replaceAll("${shell}", describeShell())
    .replaceAll("${osNote}", describeOsNote())
    .trim();
}

export function loadBashPromptSnippet(): string {
  return loadToolPromptSnippet("bash", { "${os}": detectOsLabel(), "${shell}": describeShell(), "${osNote}": describeOsNote() });
}

export function buildHostShellOptionsFor(options: { platform: RuntimePlatform; shellPath: string | undefined }): BashToolOptions | undefined {
  const { platform, shellPath } = options;
  if (platform === "win32") return undefined;
  const shellName = hostShellName(shellPath);
  if (!shellPath || !shellName) return undefined;

  const commandPrefix =
    shellName === "zsh"
      ? [
          '__pi_base_cwd="$PWD"',
          '[[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true',
          '[[ -f ~/.zprofile ]] && source ~/.zprofile >/dev/null 2>&1 || true',
          '[[ -f "${ZDOTDIR:-$HOME}/.zshrc" ]] && source "${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true',
          'cd "$__pi_base_cwd"',
        ].join("\n")
      : [
          '__pi_base_cwd="$PWD"',
          'if [[ -f ~/.bash_profile ]]; then source ~/.bash_profile >/dev/null 2>&1; elif [[ -f ~/.bash_login ]]; then source ~/.bash_login >/dev/null 2>&1; elif [[ -f ~/.profile ]]; then source ~/.profile >/dev/null 2>&1; fi',
          '[[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true',
          'cd "$__pi_base_cwd"',
        ].join("\n");

  return {
    shellPath,
    commandPrefix,
  };
}

export function buildHostShellOptions(): BashToolOptions | undefined {
  return buildHostShellOptionsFor({ platform: process.platform, shellPath: process.env.SHELL });
}

export function resolveBashToolCwd(rawWorkdir: string, parentCwd: string): string {
  return resolveToCwd(rawWorkdir, parentCwd);
}

export function buildBashRenderText(result: any, renderOptions: any, theme: any, context: any, collapsedLinesResolver?: (cwd: string, toolName: string) => number | undefined, maxCharsResolver?: (cwd: string, toolName: string) => number | undefined): { text: Text; collapsedLines: number; maxCollapsedChars: number | undefined; cwd: string; state: any } {
  const state = context?.state ?? {};
  if (state.startedAt !== undefined && renderOptions?.isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate?.(), 1000);
  }
  if (!renderOptions?.isPartial || context?.isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  const rawWorkdir = String(context?.args?.workdir ?? "").replace(/^@/, "");
  const cwd = rawWorkdir ? resolveToCwd(rawWorkdir, context.cwd ?? process.cwd()) : (context.cwd ?? process.cwd());
  const collapsedLines = resolveCollapsedResultLines("bash", undefined, context, collapsedLinesResolver) ?? 20;
  const maxCollapsedChars = resolveCollapsedResultMaxChars("bash", undefined, context, maxCharsResolver);
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(withLeadingResultNewline(formatBashResultText(result, renderOptions, theme, { ...context, state }, collapsedLines, maxCollapsedChars)));
  return { text, collapsedLines, maxCollapsedChars, cwd, state };
}
