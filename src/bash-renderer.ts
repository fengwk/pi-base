import { createBashTool, type BashToolOptions, type ExtensionAPI, DEFAULT_MAX_BYTES, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { resolveToCwd } from "./path-utils.js";
import { type CollapsedResultLinesResolver, renderCallText, renderRawResult, shortenHomePath, styleAccent, styleMuted, styleOutput, styleToolTitle, styleWarning } from "./render.js";
import { bashSchema } from "./schemas/bash.js";
import { loadToolPromptSnippet } from "./tool-prompt.js";
import { parsePositiveNumber } from "./timeout.js";

type BashExecutionTool = { execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any> };
type BashRenderDefinition = { renderResult?: (result: any, options: any, theme: any, context: any) => any };
type BashFactory = (cwd: string) => BashExecutionTool;
type BashDefinitionFactory = (cwd: string) => BashRenderDefinition;

const BASH_COLLAPSED_PREVIEW_LINES = 20;

function formatBashCall(args: any, theme: any): string {
  const rawCommand = args?.command;
  const command = typeof rawCommand === "string" ? rawCommand : "<missing-command>";
  const workdir = shortenHomePath(String(args?.workdir ?? "<missing-workdir>"));
  const timeoutSeconds = args?.timeoutSeconds;
  const timeoutSuffix = timeoutSeconds ? styleMuted(theme, ` (timeout ${timeoutSeconds}s)`) : "";
  return `${styleToolTitle(theme, `$ ${command}`)}${timeoutSuffix}${styleMuted(theme, " in ")}${styleAccent(theme, workdir)}`;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function extractBashText(result: any): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((item: any) => item?.type === "text")
    .map((item: any) => String(item.text ?? ""))
    .join("\n\n");
}

function stripStructuredTruncationFooter(output: string, result: any, options: any): string {
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

function formatBashWarnings(result: any): string[] {
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

function formatBashResultText(result: any, options: any, theme: any, context: any, collapsedLines: number): string {
  const state = context?.state ?? {};
  let output = extractBashText(result).trim();
  output = stripStructuredTruncationFooter(output, result, options);

  const styledLines = output
    ? output.split("\n").map((line) => styleOutput(theme, line))
    : [];
  const visibleLines = options?.expanded
    ? styledLines
    : collapsedLines === 0
      ? []
      : styledLines.slice(-collapsedLines);
  const hiddenLineCount = styledLines.length - visibleLines.length;
  const sections: string[] = [];

  if (!options?.expanded && hiddenLineCount > 0) {
    sections.push(styleMuted(theme, `... (${hiddenLineCount} earlier lines, ctrl+o to expand)`));
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

type RuntimePlatform = NodeJS.Platform | string;

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

function loadBashDescription(): string {
  const template = readFileSync(new URL("../prompts/bash.md", import.meta.url), "utf8");
  return template
    .replaceAll("${os}", detectOsLabel())
    .replaceAll("${shell}", describeShell())
    .replaceAll("${osNote}", describeOsNote())
    .trim();
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

function buildHostShellOptions(): BashToolOptions | undefined {
  return buildHostShellOptionsFor({ platform: process.platform, shellPath: process.env.SHELL });
}

export function registerBashRendererTool(
  pi: Pick<ExtensionAPI, "registerTool">,
  options: { createBuiltInBashTool?: BashFactory; createBuiltInBashToolDefinition?: BashDefinitionFactory; getCollapsedResultLines?: CollapsedResultLinesResolver } = {},
) {
  const shellOptions = buildHostShellOptions();
  const builtins = new Map<string, { tool: BashExecutionTool; definition: BashRenderDefinition }>();
  const getBuiltIn = (cwd: string): { tool: BashExecutionTool; definition: BashRenderDefinition } => {
    let entry = builtins.get(cwd);
    if (!entry) {
      entry = {
        tool: options.createBuiltInBashTool ? options.createBuiltInBashTool(cwd) : createBashTool(cwd, shellOptions),
        definition: options.createBuiltInBashToolDefinition ? options.createBuiltInBashToolDefinition(cwd) : {},
      };
      builtins.set(cwd, entry);
    }
    return entry;
  };

  const tool = {
    name: "bash",
    label: "bash",
    description: loadBashDescription(),
    promptSnippet: loadToolPromptSnippet("bash", { "${os}": detectOsLabel(), "${shell}": describeShell(), "${osNote}": describeOsNote() }),
    parameters: bashSchema,
    renderCall(args: any, _theme: any, context: any) {
      const state = context.state ?? {};
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      return renderCallText(formatBashCall(args, _theme), context.lastComponent);
    },
    renderResult(result: any, renderOptions: any, _theme: any, context: any) {
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
      const configuredCollapsedLines = options.getCollapsedResultLines?.(context?.cwd ?? process.cwd(), "bash");
      const collapsedLines = configuredCollapsedLines ?? BASH_COLLAPSED_PREVIEW_LINES;
      const builtIn = getBuiltIn(cwd);
      if (configuredCollapsedLines === undefined && options.createBuiltInBashToolDefinition && builtIn.definition.renderResult) {
        const builtInContext = {
          ...context,
          state,
          invalidate: context?.invalidate ?? (() => undefined),
        };
        try {
          return builtIn.definition.renderResult(result, renderOptions, _theme, builtInContext);
        } catch {
          // Fall back when an injected test renderer cannot run.
        }
      }

      try {
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatBashResultText(result, renderOptions, _theme, { ...context, state }, collapsedLines));
        return text;
      } catch {
        return renderRawResult(result, { ...renderOptions, collapsedLines }, _theme, context);
      }
    },
    async execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx: any = {}) {
      try {
        const rawWorkdir = String(params.workdir ?? "").replace(/^@/, "");
        if (!rawWorkdir) throw new Error("workdir is required.");
        const cwd = resolveToCwd(rawWorkdir, ctx.cwd ?? process.cwd());
        const builtIn = getBuiltIn(cwd);
        const timeoutSeconds = params.timeoutSeconds === undefined ? undefined : parsePositiveNumber(params.timeoutSeconds, "timeoutSeconds", 1);
        return await builtIn.tool.execute(
          toolCallId,
          {
            command: params.command,
            timeout: timeoutSeconds,
          },
          signal,
          onUpdate,
          ctx,
        );
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
      }
    },
  };
  pi.registerTool(tool as any);
  return tool;
}
