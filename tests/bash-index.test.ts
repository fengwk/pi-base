import { describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildHostShellOptionsFor, describeOsNoteFor, describeShellFor, detectOsLabel, detectOsLabelFrom, registerBashRendererTool } from "../src/bash-renderer.js";
import piBaseExtension from "../index.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";
import { lspManager } from "../src/lsp/client.js";

describe("bash tool and index", () => {
  it("detects WSL from environment variables and proc fallbacks", () => {
    expect(detectOsLabelFrom({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } })).toBe("wsl");
    expect(detectOsLabelFrom({ platform: "linux", env: { WSL_INTEROP: "/run/WSL" } })).toBe("wsl");
    expect(
      detectOsLabelFrom({
        platform: "linux",
        env: {},
        readTextFile: (path) => (path === "/proc/version" ? "Linux version 5.15.90.1-microsoft-standard-WSL2" : undefined),
      }),
    ).toBe("wsl");
    expect(
      detectOsLabelFrom({
        platform: "linux",
        env: {},
        readTextFile: (path) => (path === "/proc/sys/kernel/osrelease" ? "5.15.90.1-microsoft-standard-WSL2" : undefined),
      }),
    ).toBe("wsl");
  });

  it("distinguishes plain linux, macos, and windows", () => {
    expect(detectOsLabelFrom({ platform: "linux", env: {}, readTextFile: () => "Linux version generic" })).toBe("linux");
    expect(detectOsLabelFrom({ platform: "darwin", env: {} })).toBe("macos");
    expect(detectOsLabelFrom({ platform: "win32", env: {} })).toBe("windows");
    expect(describeOsNoteFor("wsl")).toContain("/mnt/<drive>");
    expect(describeOsNoteFor("linux")).toBe("Linux environment.");
    expect(describeOsNoteFor("macos")).toBe("macOS environment.");
    expect(describeOsNoteFor("windows")).toBe("Windows environment.");
    expect(describeOsNoteFor("plan9")).toBe("plan9 environment.");
  });

  it("detects the current runtime platform label", () => {
    expect(["linux", "wsl", "macos", "windows"]).toContain(detectOsLabel());
  });

  it("describes shell selection and host shell startup options", () => {
    expect(describeShellFor({ platform: "linux", shellPath: "/bin/bash" })).toBe("bash");
    expect(describeShellFor({ platform: "linux", shellPath: "/bin/zsh" })).toBe("zsh");
    expect(describeShellFor({ platform: "win32", shellPath: undefined })).toBe("platform-default");
    expect(describeShellFor({ platform: "linux", shellPath: "/bin/fish" })).toBe("/bin/bash or sh fallback");

    const bashOptions = buildHostShellOptionsFor({ platform: "linux", shellPath: "/bin/bash" });
    expect(bashOptions?.shellPath).toBe("/bin/bash");
    expect(bashOptions?.commandPrefix).toContain(".bashrc");

    const zshOptions = buildHostShellOptionsFor({ platform: "linux", shellPath: "/bin/zsh" });
    expect(zshOptions?.shellPath).toBe("/bin/zsh");
    expect(zshOptions?.commandPrefix).toContain(".zshrc");

    expect(buildHostShellOptionsFor({ platform: "win32", shellPath: "/bin/bash" })).toBeUndefined();
    expect(buildHostShellOptionsFor({ platform: "linux", shellPath: "/bin/fish" })).toBeUndefined();
  });

  it("maps timeoutSeconds to builtin bash timeout", async () => {
    const registry = createToolRegistry();
    let seenParams: any;
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({
        execute: async (_toolCallId: string, params: any) => {
          seenParams = params;
          return { content: [{ type: "text", text: "ok" }] };
        },
      }),
    });

    const result = await registry.getTool("bash").execute("1", { command: "npm test", workdir: ".", timeoutSeconds: 30 }, undefined, undefined, { cwd: process.cwd() });
    expect(getText(result)).toBe("ok");
    expect(seenParams).toEqual({ command: "npm test", timeout: 30 });
  });

  it("requires an explicit workdir", async () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
    });
    const result = await registry.getTool("bash").execute("1", { command: "pwd" }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("workdir is required");
  });

  it("surfaces bash execution errors", async () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({
        execute: async () => {
          throw new Error("boom");
        },
      }),
    });
    const result = await registry.getTool("bash").execute("1", { command: "bad", workdir: "." }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("boom");
  });

  it("executes through the default builtin bash tool", async () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any);
    const result = await registry.getTool("bash").execute("1", { command: "pwd", workdir: "." }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain(process.cwd());
  });

  it("truncates huge bash output and saves the full output to a temp file", async () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({
        execute: async () => ({ content: [{ type: "text", text: Array.from({ length: 2505 }, (_, index) => `line-${index + 1}`).join("\n") }] }),
      }),
    });
    const result = await registry.getTool("bash").execute("1", { command: "huge", workdir: "." }, undefined, undefined, { cwd: process.cwd() });
    const text = getText(result);
    expect(text).toContain("The tool call succeeded but the output was truncated");
    const outputPath = result.details?.truncation?.outputPath;
    expect(outputPath).toBeTruthy();
    const saved = await readFile(outputPath, "utf8");
    expect(saved).toContain("line-2505");
  });

  it("repairs lost isError flags in tool_result handlers", async () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const readResult = await registry.emit("tool_result", {
      toolName: "read",
      toolCallId: "1",
      input: { path: "missing.txt" },
      content: [{ type: "text", text: "Error: ENOENT: missing" }],
      details: undefined,
      isError: false,
    });
    expect(readResult.isError).toBe(true);

    const editResult = await registry.emit("tool_result", {
      toolName: "edit",
      toolCallId: "2",
      input: { path: "src/example.ts" },
      content: [{ type: "text", text: "Edit failed for src/example.ts. Fresh anchors are required before editing this file." }],
      details: undefined,
      isError: false,
    });
    expect(editResult.isError).toBe(true);

    const bashResult = await registry.emit("tool_result", {
      toolName: "bash",
      toolCallId: "3",
      input: { command: "false", workdir: "." },
      content: [{ type: "text", text: "Error: (no output)\n\nCommand exited with code 1" }],
      details: undefined,
      isError: false,
    });
    expect(bashResult.isError).toBe(true);
  });

  it("enables the default base tool set and injects the base guide", async () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { reason: "startup" });
    expect(registry.getActiveTools()).toEqual(["read", "grep", "find", "bash", "edit", "write", "lsp_diagnostics", "lsp_goto_definition", "lsp_workspace_symbols", "lsp_java_decompile"]);

    const injected = await registry.emit("before_agent_start", {
      systemPrompt: "base system prompt",
      systemPromptOptions: { selectedTools: registry.getActiveTools() },
    });

    expect(injected.systemPrompt).toContain("base system prompt");
    expect(injected.systemPrompt).toContain("Base Tool Usage Guidance");
    expect(injected.systemPrompt).toContain("Use `bash` only for build, test, git");
  });

  it("preserves an explicit active tool set", async () => {
    const registry = createToolRegistry();
    registry.pi.setActiveTools(["read"]);
    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { reason: "startup" });
    expect(registry.getActiveTools()).toEqual(["read"]);
  });

  it("syncs LSP after successful write", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    let synced: string | undefined;
    const original = lspManager.syncFileIfOpen.bind(lspManager);
    lspManager.syncFileIfOpen = async (filePath: string) => {
      synced = filePath;
    };
    try {
      await registry.getTool("write").execute("1", { path: "sync-test.ts", content: "export const x = 1;\n" }, undefined, undefined, { cwd: root });
      expect(synced).toBe(join(root, "sync-test.ts"));
    } finally {
      lspManager.syncFileIfOpen = original;
    }
  });

  it("isolates LSP server config across two project settings", async () => {
    // Project A: declares a typescript LSP server pointing at a real binary.
    const rootA = await createTempWorkspace();
    const binA = join(rootA, "bin");
    await mkdir(binA, { recursive: true });
    const fakeA = join(binA, "fake-a-lsp");
    await writeFile(fakeA, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
    await mkdir(join(rootA, ".pi", "pi-base"), { recursive: true });
    await writeFile(
      join(rootA, ".pi", "pi-base", "settings.json"),
      JSON.stringify({ lsp: { searchPaths: [binA], servers: { ts: { command: ["fake-a-lsp"], extensions: [".ts"] } } } }),
      "utf8",
    );
    await writeWorkspaceFile(rootA, "src/example.ts", "export const x = 1;\n");

    // Project B: declares a DIFFERENT typescript LSP server pointing at a different binary.
    const rootB = await createTempWorkspace();
    const binB = join(rootB, "bin");
    await mkdir(binB, { recursive: true });
    const fakeB = join(binB, "fake-b-lsp");
    await writeFile(fakeB, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
    await mkdir(join(rootB, ".pi", "pi-base"), { recursive: true });
    await writeFile(
      join(rootB, ".pi", "pi-base", "settings.json"),
      JSON.stringify({ lsp: { searchPaths: [binB], servers: { ts: { command: ["fake-b-lsp"], extensions: [".ts"] } } } }),
      "utf8",
    );
    await writeWorkspaceFile(rootB, "src/example.ts", "export const y = 2;\n");

    const previousGlobalSettingsPath = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
    process.env.PI_BASE_GLOBAL_SETTINGS_PATH = join(await createTempWorkspace(), "global-settings.json");
    try {
      // Boot the extension once. It should pick up project A's settings.
      const registry = createToolRegistry();
      piBaseExtension(registry.pi as any);

      // Read from project A -> should see the LSP support header.
      const readA = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: rootA });
      const textA = getText(readA);
      expect(textA).toContain("lsp: supported (ts)");

      // Read from project B -> should see the LSP support header for B's server.
      const readB = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: rootB });
      const textB = getText(readB);
      expect(textB).toContain("lsp: supported (ts)");

      // Now mutate project A's settings to declare a MISSING binary only.
      // If the extension leaked A's original config into B, B would still report
      // "supported" even though A's binary is gone.
      await rm(fakeA);
      // Force a fresh resolver for A by writing new settings.
      await writeFile(
        join(rootA, ".pi", "pi-base", "settings.json"),
        JSON.stringify({ lsp: { searchPaths: [binA], servers: { ts: { command: ["fake-a-lsp"], extensions: [".ts"] } } } }),
        "utf8",
      );
      // Create a NEW extension instance (simulating a fresh session) and check A.
      const registry2 = createToolRegistry();
      piBaseExtension(registry2.pi as any);
      const readAAfter = await registry2.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: rootA });
      expect(getText(readAAfter)).toContain("not installed");

      // Project B should be unaffected: its own binary still exists.
      const readBAfter = await registry2.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: rootB });
      expect(getText(readBAfter)).toContain("lsp: supported (ts)");
    } finally {
      if (previousGlobalSettingsPath === undefined) {
        delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
      } else {
        process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
      }
    }
  });
});
