import { describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadPiBaseSettings } from "../src/config.js";
import { LspDiscoveryResolver } from "../src/lsp/discovery.js";
import { createTempWorkspace } from "./helpers.js";

async function withTempGlobalSettings<T>(run: (globalPath: string) => Promise<T> | T): Promise<T> {
  const previous = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  const root = await createTempWorkspace();
  const globalPath = join(root, "global-settings.json");
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalPath;
  try {
    return await run(globalPath);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
    } else {
      process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previous;
    }
  }
}


describe("pi-base config", () => {
  it("loads project settings and overrides global lsp fields", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    const projectPath = join(projectDir, "pi-base.json");
    const globalServers = { jdtls: { command: ["global-jdtls"], extensions: [".java"] } };
    const projectServers = { jdtls: { command: ["project-jdtls"], extensions: [".java"] }, gopls: { command: ["gopls"], extensions: [".go"] } };
    await withTempGlobalSettings(async (globalPath) => {
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, JSON.stringify({ lsp: { searchPaths: ["/global/bin"], servers: globalServers } }), "utf8");
      await writeFile(projectPath, JSON.stringify({ lsp: { searchPaths: ["/project/bin"], servers: projectServers } }), "utf8");
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.lsp?.searchPaths).toEqual(["/project/bin"]);
      expect(loaded.settings.lsp?.servers?.jdtls?.command).toEqual(["project-jdtls"]);
      expect(loaded.settings.lsp?.servers?.gopls?.command).toEqual(["gopls"]);
    });
  });

  it("loads project settings from the nearest ancestor settings file", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    const childDir = join(root, "packages", "app", "src");
    await mkdir(projectDir, { recursive: true });
    await mkdir(childDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ lsp: { searchPaths: ["/repo-root/bin"] } }), "utf8");
      const loaded = loadPiBaseSettings(childDir);
      expect(loaded.projectPath).toBe(join(projectDir, "pi-base.json"));
      expect(loaded.settings.lsp?.searchPaths).toEqual(["/repo-root/bin"]);
    });
  });

  it("loads per-tool render settings from unified pi-base config and merges project overrides", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async (globalPath) => {
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, JSON.stringify({ render: { collapsedToolResultLines: 12 } }), "utf8");
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ render: { collapsedToolResultLines: { read: 0, grep: 15 } } }), "utf8");
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.render).toEqual({ collapsedToolResultLines: { "*": 12, read: 0, grep: 15 } });
    });
  });

  it("resolves relative project searchPaths and command paths against the settings file directory", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    const childDir = join(root, "packages", "app");
    await mkdir(projectDir, { recursive: true });
    await mkdir(childDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(
        join(projectDir, "pi-base.json"),
        JSON.stringify({
          lsp: {
            searchPaths: ["./bin"],
            servers: {
              ts: { command: ["./servers/mock-ts-lsp", "--stdio"], extensions: [".ts"] },
            },
          },
        }),
        "utf8",
      );
      const loaded = loadPiBaseSettings(childDir);
      expect(loaded.settings.lsp?.searchPaths).toEqual([join(projectDir, "bin")]);
      expect(loaded.settings.lsp?.servers?.ts?.command).toEqual([join(projectDir, "servers", "mock-ts-lsp"), "--stdio"]);
    });
  });

  it("expands ~/ and $HOME in lsp searchPaths and command paths", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(
        join(projectDir, "pi-base.json"),
        JSON.stringify({
          lsp: {
            searchPaths: ["~/.local/share/nvim/mason/bin", "$HOME/.cache/tools/bin", "${HOME}/opt/lsp/bin"],
            servers: {
              ts: { command: ["$HOME/bin/mock-ts-lsp", "--stdio"], extensions: [".ts"] },
              js: { command: ["${HOME}/bin/mock-js-lsp", "--stdio"], extensions: [".js"] },
            },
          },
        }),
        "utf8",
      );
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.lsp?.searchPaths).toEqual([
        join(homedir(), ".local", "share", "nvim", "mason", "bin"),
        join(homedir(), ".cache", "tools", "bin"),
        join(homedir(), "opt", "lsp", "bin"),
      ]);
      expect(loaded.settings.lsp?.servers?.ts?.command).toEqual([join(homedir(), "bin", "mock-ts-lsp"), "--stdio"]);
      expect(loaded.settings.lsp?.servers?.js?.command).toEqual([join(homedir(), "bin", "mock-js-lsp"), "--stdio"]);
    });
  });

  it("does not rewrite non-HOME environment placeholders in lsp command paths", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(
        join(projectDir, "pi-base.json"),
        JSON.stringify({
          lsp: {
            servers: {
              java: { command: ["$JAVA_HOME/bin/jdtls", "--stdio"], extensions: [".java"] },
            },
          },
        }),
        "utf8",
      );
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.lsp?.servers?.java?.command).toEqual(["$JAVA_HOME/bin/jdtls", "--stdio"]);
    });
  });

  it("loads permission rules from unified pi-base config and merges global/project entries", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async (globalPath) => {
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(
        globalPath,
        JSON.stringify({
          permission: {
            "*": "allow",
            bash: { "*": "ask", "git *": "allow" },
            write: "deny",
          },
        }),
        "utf8",
      );
      await writeFile(
        join(projectDir, "pi-base.json"),
        JSON.stringify({
          permission: {
            bash: { "npm *": "allow" },
            write: "ask",
          },
        }),
        "utf8",
      );
      const loaded = loadPiBaseSettings(root);
      expect(loaded.projectPath).toBe(join(projectDir, "pi-base.json"));
      expect(loaded.settings.permission).toEqual({
        "*": [{ pattern: "*", action: "allow" }],
        bash: [
          { pattern: "*", action: "ask" },
          { pattern: "git *", action: "allow" },
          { pattern: "npm *", action: "allow" },
        ],
        write: [
          { pattern: "*", action: "deny" },
          { pattern: "*", action: "ask" },
        ],
      });
    });
  });

  it("loads default yolo flag from unified pi-base config and lets project settings override it", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async (globalPath) => {
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, JSON.stringify({ yolo: true }), "utf8");
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ yolo: false }), "utf8");
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.yolo).toBe(false);
    });
  });

  it("rejects the removed top-level contextHygiene switch", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ contextHygiene: true }), "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(/contextHygiene is no longer supported\. Use contextCompression instead/);
    });
  });

  it("loads context compression settings and lets project settings override individual tool values", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async (globalPath) => {
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, JSON.stringify({
        contextCompression: {
          anchorHygiene: true,
          tools: {
            bash: { retainedUserMessageRounds: 4, retainedAssistantTurns: 8 },
            custom_tool: { enable: false },
          },
        },
      }), "utf8");
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({
        contextCompression: {
          anchorHygiene: false,
          tools: {
            bash: { retainedAssistantTurns: 6 },
            read: { enable: true },
          },
        },
      }), "utf8");
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.contextCompression).toEqual({
        anchorHygiene: false,
        tools: {
          bash: { retainedUserMessageRounds: 4, retainedAssistantTurns: 6 },
          custom_tool: { enable: false },
          read: { enable: true },
        },
      });
    });
  });

  it("applies configured search paths to a resolver", async () => {
    const root = await createTempWorkspace();
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const fake = join(binDir, "fake-lsp");
    await writeFile(fake, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
    const resolver = new LspDiscoveryResolver({ searchPaths: [binDir] });
    expect(resolver.findCommandPath("fake-lsp")).toBe(fake);
  });

  it("caches LSP availability per resolver instance", async () => {
    const root = await createTempWorkspace();
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const fake = join(binDir, "fake-ts-lsp");
    await writeFile(fake, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });

    const entry = { typescript: { command: ["fake-ts-lsp", "--stdio"], extensions: [".ts"] } };
    const installed = new LspDiscoveryResolver({ searchPaths: [binDir], servers: entry });
    expect(installed.supportsLsp(join(root, "src", "example.ts"))).toEqual({ supported: true, language: "typescript", available: true });

    await rm(fake);
    // Same resolver still reports the binary as installed (its own cache survives).
    expect(installed.supportsLsp(join(root, "src", "example.ts"))).toEqual({ supported: true, language: "typescript", available: true });

    // A freshly built resolver sees the missing binary.
    const afterRemoval = new LspDiscoveryResolver({ searchPaths: [binDir], servers: entry });
    expect(afterRemoval.supportsLsp(join(root, "src", "example.ts"))).toEqual({ supported: true, language: "typescript", available: false, reason: "not-installed" });
  });

  it("does not treat non-executable files as installed LSP binaries", async () => {
    const root = await createTempWorkspace();
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const fake = join(binDir, "fake-ts-lsp");
    await writeFile(fake, "#!/bin/sh\n", { encoding: "utf8", mode: 0o644 });
    const resolver = new LspDiscoveryResolver({
      searchPaths: [binDir],
      servers: { typescript: { command: ["fake-ts-lsp", "--stdio"], extensions: [".ts"] } },
    });
    expect(resolver.supportsLsp(join(root, "src", "example.ts"))).toEqual({ supported: true, language: "typescript", available: false, reason: "not-installed" });
  });

  it("shows a concrete settings snippet when an LSP server is missing", () => {
    const resolver = new LspDiscoveryResolver({ servers: { typescript: { command: ["missing-ts-lsp", "--stdio"], extensions: [".ts"] } } });
    expect(() => resolver.findServerForFile("/tmp/demo.ts")).toThrowError(/\.pi\/pi-base\.json/);
    expect(() => resolver.findServerForFile("/tmp/demo.ts")).toThrowError(/"typescript": \{/);
    expect(() => resolver.findServerForFile("/tmp/demo.ts")).toThrowError(/"\/absolute\/path\/to\/missing-ts-lsp"/);
  });

  it("surfaces malformed project settings", async () => {
    await withTempGlobalSettings(async () => {
      const root = await createTempWorkspace();
      const projectDir = join(root, ".pi");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "pi-base.json"), "{", "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(/Invalid pi-base settings at .*pi-base\.json/);
    });
  });

  it("surfaces invalid lsp server entries", async () => {
    await withTempGlobalSettings(async () => {
      const root = await createTempWorkspace();
      const projectDir = join(root, ".pi");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ lsp: { servers: { ts: { command: "ts-lsp", extensions: [".ts"] } } } }), "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(/lsp\.servers\.ts\.command must be an array of strings/);
    });
  });

  it("surfaces invalid permission rules from unified pi-base config", async () => {
    await withTempGlobalSettings(async () => {
      const root = await createTempWorkspace();
      const projectDir = join(root, ".pi");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, "pi-base.json"),
        JSON.stringify({ permission: { write: { "*": "maybe" } } }),
        "utf8",
      );
      expect(() => loadPiBaseSettings(root)).toThrowError(/Invalid pi-base settings at .*pi-base\.json: permission\.write\.\* must be \"allow\", \"ask\", or \"deny\"/);
    });
  });

  it("surfaces invalid yolo blocks", async () => {
    await withTempGlobalSettings(async () => {
      const root = await createTempWorkspace();
      const projectDir = join(root, ".pi");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ yolo: "maybe" }), "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(/Invalid pi-base settings at .*pi-base\.json: yolo must be a boolean/);
    });
  });

  it("surfaces invalid lsp blocks", async () => {
    await withTempGlobalSettings(async () => {
      const root = await createTempWorkspace();
      const projectDir = join(root, ".pi");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ lsp: [] }), "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(/lsp must be an object/);
    });
  });

  it("surfaces invalid render blocks", async () => {
    await withTempGlobalSettings(async () => {
      const root = await createTempWorkspace();
      const projectDir = join(root, ".pi");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ render: { collapsedToolResultLines: -1 } }), "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(/Invalid pi-base settings at .*pi-base\.json: render\.collapsedToolResultLines must be a non-negative integer/);
    });
  });

  it("rejects legacy contextHygiene blocks", async () => {
    await withTempGlobalSettings(async () => {
      const root = await createTempWorkspace();
      const projectDir = join(root, ".pi");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ contextHygiene: "yes" }), "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(/Invalid pi-base settings at .*pi-base\.json: contextHygiene is no longer supported\. Use contextCompression instead/);
    });
  });


  it("surfaces invalid context compression blocks", async () => {
    await withTempGlobalSettings(async () => {
      const root = await createTempWorkspace();
      const projectDir = join(root, ".pi");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ contextCompression: { tools: { read: { retainedUserMessageRounds: 0 } } } }), "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(/Invalid pi-base settings at .*pi-base\.json: contextCompression\.tools\.read\.retainedUserMessageRounds must be a positive integer/);
    });
  });
});
