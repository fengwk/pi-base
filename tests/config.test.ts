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
  it("loads project settings and overrides global lsp server entries", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    const projectPath = join(projectDir, "pi-base.json");
    const globalServers = { jdtls: { command: ["global-jdtls"], extensions: [".java"] } };
    const projectServers = { jdtls: { command: ["project-jdtls"], extensions: [".java"] }, gopls: { command: ["gopls"], extensions: [".go"] } };
    await withTempGlobalSettings(async (globalPath) => {
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, JSON.stringify({ lsp: { servers: globalServers } }), "utf8");
      await writeFile(projectPath, JSON.stringify({ lsp: { servers: projectServers } }), "utf8");
      const loaded = loadPiBaseSettings(root);
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
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ lsp: { servers: { ts: { command: ["ts-lsp"], extensions: [".ts"] } } } }), "utf8");
      const loaded = loadPiBaseSettings(childDir);
      expect(loaded.projectPath).toBe(join(projectDir, "pi-base.json"));
      expect(loaded.settings.lsp?.servers?.ts?.command).toEqual(["ts-lsp"]);
    });
  });

  it("loads per-tool render settings from unified pi-base config and merges project overrides", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async (globalPath) => {
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, JSON.stringify({
        render: {
          collapsedToolResultLines: 12,
          collapsedToolResultMaxChars: 1000,
        },
      }), "utf8");
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({
        render: {
          collapsedToolResultLines: { read: 0, grep: 15 },
          collapsedToolResultMaxChars: { read: 200, echo: 20 },
        },
      }), "utf8");
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.render).toEqual({
        collapsedToolResultLines: { "*": 12, read: 0, grep: 15 },
        collapsedToolResultMaxChars: { "*": 1000, read: 200, echo: 20 },
      });
    });
  });


  it("rejects relative lsp command paths", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(
        join(projectDir, "pi-base.json"),
        JSON.stringify({ lsp: { servers: { ts: { command: ["./servers/mock-ts-lsp", "--stdio"], extensions: [".ts"] } } } }),
        "utf8",
      );
      expect(() => loadPiBaseSettings(root)).toThrowError(/command\[0\] must be a command on PATH or an absolute executable path/);
    });
  });

  it("expands ~/ and $HOME in lsp command paths", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(
        join(projectDir, "pi-base.json"),
        JSON.stringify({
          lsp: {
            servers: {
              ts: { command: ["$HOME/bin/mock-ts-lsp", "--stdio"], extensions: [".ts"] },
              js: { command: ["${HOME}/bin/mock-js-lsp", "--stdio"], extensions: [".js"] },
              py: { command: ["~/bin/mock-py-lsp", "--stdio"], extensions: [".py"] },
            },
          },
        }),
        "utf8",
      );
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.lsp?.servers?.ts?.command).toEqual([join(homedir(), "bin", "mock-ts-lsp"), "--stdio"]);
      expect(loaded.settings.lsp?.servers?.js?.command).toEqual([join(homedir(), "bin", "mock-js-lsp"), "--stdio"]);
      expect(loaded.settings.lsp?.servers?.py?.command).toEqual([join(homedir(), "bin", "mock-py-lsp"), "--stdio"]);
    });
  });

  it("rejects non-HOME environment placeholders in lsp command paths", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(
        join(projectDir, "pi-base.json"),
        JSON.stringify({ lsp: { servers: { java: { command: ["$JAVA_HOME/bin/jdtls", "--stdio"], extensions: [".java"] } } } }),
        "utf8",
      );
      expect(() => loadPiBaseSettings(root)).toThrowError(/command\[0\] must be a command on PATH or an absolute executable path/);
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

  it("loads notify settings and lets project settings override individual flags", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async (globalPath) => {
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, JSON.stringify({
        notify: {
          permissionAsked: true,
          agentEnd: false,
        },
      }), "utf8");
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({
        notify: {
          agentEnd: true,
        },
      }), "utf8");
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.notify).toEqual({
        permissionAsked: true,
        agentEnd: true,
      });
    });
  });
  it("accepts notify.suppressCompletedAfterRejectionMs as a non-negative integer", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({
        notify: { suppressCompletedAfterRejectionMs: 0 },
      }), "utf8");
      expect(loadPiBaseSettings(root).settings.notify?.suppressCompletedAfterRejectionMs).toBe(0);

      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({
        notify: { suppressCompletedAfterRejectionMs: 750 },
      }), "utf8");
      expect(loadPiBaseSettings(root).settings.notify?.suppressCompletedAfterRejectionMs).toBe(750);
    });
  });
  it("rejects negative or non-integer notify.suppressCompletedAfterRejectionMs values", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      for (const bad of [-1, 1.5, "500"]) {
        await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({
          notify: { suppressCompletedAfterRejectionMs: bad },
        }), "utf8");
        expect(() => loadPiBaseSettings(root)).toThrow(/suppressCompletedAfterRejectionMs/);
      }
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


  it("loads context compression settings and lets project settings override shared retention values and tool list", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async (globalPath) => {
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, JSON.stringify({
        contextCompression: {
          anchorHygiene: true,
          retainedUserMessageRounds: 4,
          retainedAssistantTurns: 8,
          tools: ["bash", "custom_tool"],
        },
      }), "utf8");
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({
        contextCompression: {
          anchorHygiene: false,
          retainedAssistantTurns: 6,
          tools: ["bash", "read"],
        },
      }), "utf8");
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.contextCompression).toEqual({
        anchorHygiene: false,
        retainedUserMessageRounds: 4,
        retainedAssistantTurns: 6,
        tools: ["bash", "read"],
      });
    });
  });

  it("resolves explicit executable paths", async () => {
    const root = await createTempWorkspace();
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const fake = join(binDir, "fake-lsp");
    await writeFile(fake, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
    const resolver = new LspDiscoveryResolver({});
    expect(resolver.findCommandPath(fake)).toBe(fake);
  });

  it("caches LSP availability per resolver instance", async () => {
    const root = await createTempWorkspace();
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const fake = join(binDir, "fake-ts-lsp");
    await writeFile(fake, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });

    const entry = { typescript: { command: [fake, "--stdio"], extensions: [".ts"] } };
    const installed = new LspDiscoveryResolver({ servers: entry });
    expect(installed.supportsLsp(join(root, "src", "example.ts"))).toEqual({ supported: true, language: "typescript", available: true });

    await rm(fake);
    // Same resolver still reports the binary as installed (its own cache survives).
    expect(installed.supportsLsp(join(root, "src", "example.ts"))).toEqual({ supported: true, language: "typescript", available: true });

    // A freshly built resolver sees the missing binary.
    const afterRemoval = new LspDiscoveryResolver({ servers: entry });
    expect(afterRemoval.supportsLsp(join(root, "src", "example.ts"))).toEqual({ supported: true, language: "typescript", available: false, reason: "not-installed" });
  });

  it("does not treat non-executable files as installed LSP binaries", async () => {
    const root = await createTempWorkspace();
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const fake = join(binDir, "fake-ts-lsp");
    await writeFile(fake, "#!/bin/sh\n", { encoding: "utf8", mode: 0o644 });
    const resolver = new LspDiscoveryResolver({
      servers: { typescript: { command: [fake, "--stdio"], extensions: [".ts"] } },
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



  it("surfaces invalid context compression blocks", async () => {
    await withTempGlobalSettings(async () => {
      const root = await createTempWorkspace();
      const projectDir = join(root, ".pi");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ contextCompression: { retainedUserMessageRounds: 0 } }), "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(/Invalid pi-base settings at .*pi-base\.json: contextCompression\.retainedUserMessageRounds must be a positive integer/);
    });
  });

  it("rejects legacy per-tool context compression objects", async () => {
    await withTempGlobalSettings(async () => {
      const root = await createTempWorkspace();
      const projectDir = join(root, ".pi");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ contextCompression: { tools: { bash: {} } } }), "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(/Invalid pi-base settings at .*pi-base\.json: contextCompression\.tools must be an array of strings/);
    });
  });
});
