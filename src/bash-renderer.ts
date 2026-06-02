import { createBashTool, type BashToolOptions, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { resolveToCwd } from "./path-utils.js";
import { formatOptionalArgs, renderCallText, renderRawResult, shortenHomePath, styleAccent, styleMuted, styleOutput, styleToolTitle } from "./render.js";
import { bashSchema } from "./schemas/bash.js";
import { loadToolPromptSnippet } from "./tool-prompt.js";
import { parsePositiveNumber } from "./timeout.js";

type BashFactory = (cwd: string) => { execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any> };

function formatBashCall(args: any, theme: any): string {
  const command = String(args?.command ?? "<missing-command>");
  const workdir = shortenHomePath(String(args?.workdir ?? "<missing-workdir>"));
  const suffix = formatOptionalArgs([["timeoutSeconds", args?.timeoutSeconds]]);
  return `${styleToolTitle(theme, "$")} ${styleOutput(theme, command)} ${styleMuted(theme, "in")} ${styleAccent(theme, workdir)}${styleOutput(theme, suffix)}`;
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
  options: { createBuiltInBashTool?: BashFactory } = {},
) {
  const builtins = new Map<string, any>();
  const getBuiltIn = (cwd: string) => {
    let tool = builtins.get(cwd);
    if (!tool) {
      tool = options.createBuiltInBashTool ? options.createBuiltInBashTool(cwd) : createBashTool(cwd, buildHostShellOptions());
      builtins.set(cwd, tool);
    }
    return tool;
  };

  const tool = {
    name: "bash",
    label: "bash",
    description: loadBashDescription(),
    promptSnippet: loadToolPromptSnippet("bash", { "${os}": detectOsLabel(), "${shell}": describeShell(), "${osNote}": describeOsNote() }),
    parameters: bashSchema,
    renderCall(args: any, _theme: any, context: any) {
      return renderCallText(formatBashCall(args, _theme), context.lastComponent);
    },
    renderResult(result: any, options: any, _theme: any, context: any) {
      return renderRawResult(result, options, _theme, context);
    },
    async execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx: any = {}) {
      try {
        const rawWorkdir = String(params.workdir ?? "").replace(/^@/, "");
        if (!rawWorkdir) throw new Error("workdir is required.");
        const cwd = resolveToCwd(rawWorkdir, ctx.cwd ?? process.cwd());
        const builtIn = getBuiltIn(cwd);
        const timeoutSeconds = params.timeoutSeconds === undefined ? undefined : parsePositiveNumber(params.timeoutSeconds, "timeoutSeconds", 1);
        return await builtIn.execute(
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
