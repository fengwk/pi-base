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

  it("falls back to proc files when WSL environment variables are absent", () => {
    const previousDistro = process.env.WSL_DISTRO_NAME;
    const previousInterop = process.env.WSL_INTEROP;
    try {
      delete process.env.WSL_DISTRO_NAME;
      delete process.env.WSL_INTEROP;
      expect(["linux", "wsl", "macos", "windows"]).toContain(detectOsLabel());
    } finally {
      if (previousDistro === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = previousDistro;
      if (previousInterop === undefined) delete process.env.WSL_INTEROP;
      else process.env.WSL_INTEROP = previousInterop;
    }
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

  it("uses the built-in bash result renderer when available", () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
      createBuiltInBashToolDefinition: () => ({
        renderResult: () => ({
          render: () => ["builtin bash renderer"],
          invalidate: () => {},
        }),
      }),
    });

    const tool = registry.getTool("bash");
    const rendered = tool.renderResult(
      { content: [{ type: "text", text: "line-1\nline-2" }] },
      { expanded: false, isPartial: false },
      {} as any,
      { lastComponent: undefined, args: { workdir: "." }, cwd: process.cwd(), state: {} },
    ).render(200).join("\n");

    expect(rendered).toContain("builtin bash renderer");
  });

  it("uses the pi-base bash result renderer when collapsed result lines are configured", () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
      createBuiltInBashToolDefinition: () => ({
        renderResult: () => ({
          render: () => ["builtin bash renderer"],
          invalidate: () => {},
        }),
      }),
      getCollapsedResultLines: () => 0,
    });

    const tool = registry.getTool("bash");
    const rendered = tool.renderResult(
      { content: [{ type: "text", text: "line-1\nline-2\nline-3" }] },
      { expanded: false, isPartial: false },
      {} as any,
      { lastComponent: undefined, args: { workdir: "." }, cwd: process.cwd(), state: {} },
    ).render(200).join("\n");

    expect(rendered).not.toContain("builtin bash renderer");
    expect(rendered).not.toContain("line-1");
    expect(rendered).not.toContain("line-3");
    expect(rendered).toContain("3 earlier lines");
  });

  it("tracks bash execution timing state from renderCall", () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
    });

    const tool = registry.getTool("bash");
    const state: any = {};
    tool.renderCall(
      { command: "pwd", workdir: ".", timeoutSeconds: 5 },
      {} as any,
      { lastComponent: undefined, executionStarted: true, state },
    );

    expect(typeof state.startedAt).toBe("number");
    expect(state.endedAt).toBeUndefined();
  });

  it("shows 20 trailing lines in collapsed bash results", () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
    });

    const tool = registry.getTool("bash");
    const output = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");
    const rendered = tool.renderResult(
      { content: [{ type: "text", text: output }] },
      { expanded: false, isPartial: false },
      {} as any,
      { lastComponent: undefined, args: { workdir: "." }, cwd: process.cwd(), state: { startedAt: Date.now(), endedAt: Date.now() } },
    ).render(200).join("\n");

    expect(rendered).toContain("line-11");
    expect(rendered).toContain("line-30");
    expect(rendered).not.toContain("line-10");
    expect(rendered).toContain("earlier lines");
  });

  it("supports zero-line collapsed bash previews when configured", () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
      getCollapsedResultLines: () => 0,
    });

    const tool = registry.getTool("bash");
    const output = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");
    const rendered = tool.renderResult(
      { content: [{ type: "text", text: output }] },
      { expanded: false, isPartial: false },
      {} as any,
      { lastComponent: undefined, args: { workdir: "." }, cwd: process.cwd(), state: { startedAt: Date.now(), endedAt: Date.now() } },
    ).render(200).join("\n");

    expect(rendered).not.toContain("line-1");
    expect(rendered).not.toContain("line-30");
    expect(rendered).toContain("30 earlier lines");
  });

  it("renders built-in bash truncation metadata without duplicating the upstream footer", () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
    });

    const tool = registry.getTool("bash");
    const outputPath = "/tmp/pi-bash-output.log";
    const rendered = tool.renderResult(
      {
        content: [{ type: "text", text: `line-1\n\n[Showing lines 1-1 of 100. Full output: ${outputPath}]` }],
        details: {
          fullOutputPath: outputPath,
          truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 100 },
        },
      },
      { expanded: false, isPartial: false },
      {} as any,
      { lastComponent: undefined, args: { workdir: "." }, cwd: process.cwd(), state: {} },
    ).render(200).join("\n");

    expect(rendered).toContain("line-1");
    expect(rendered).not.toContain("[Showing lines");
    expect(rendered).toContain(`Full output: ${outputPath}`);
    expect(rendered).toContain("Truncated: showing 1 of 100 lines");
  });

  it("renders byte-limit bash truncation warnings", () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
    });

    const tool = registry.getTool("bash");
    const rendered = tool.renderResult(
      {
        content: [{ type: "text", text: "line-1\nline-2" }],
        details: {
          truncation: { truncated: true, outputLines: 2, totalLines: 100, maxBytes: 1024 },
        },
      },
      { expanded: false, isPartial: false },
      {} as any,
      { lastComponent: undefined, args: { workdir: "." }, cwd: process.cwd(), state: {} },
    ).render(200).join("\n");

    expect(rendered).toContain("Truncated: 2 lines shown");
    expect(rendered).toContain("limit");
  });

  it("starts and clears bash elapsed-time refresh intervals", () => {
    const registry = createToolRegistry();
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
    });

    const tool = registry.getTool("bash");
    const state: any = { startedAt: Date.now() };
    const context: any = {
      lastComponent: undefined,
      args: { workdir: "." },
      cwd: process.cwd(),
      state,
      invalidate: () => undefined,
    };

    tool.renderResult({ content: [{ type: "text", text: "running" }] }, { expanded: false, isPartial: true }, {} as any, context);
    expect(state.interval).toBeDefined();

    tool.renderResult({ content: [{ type: "text", text: "done" }] }, { expanded: false, isPartial: false }, {} as any, context);
    expect(state.interval).toBeUndefined();
    expect(state.endedAt).toBeDefined();
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
    await mkdir(join(rootA, ".pi"), { recursive: true });
    await writeFile(
      join(rootA, ".pi", "pi-base.json"),
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
    await mkdir(join(rootB, ".pi"), { recursive: true });
    await writeFile(
      join(rootB, ".pi", "pi-base.json"),
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
        join(rootA, ".pi", "pi-base.json"),
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
