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

  it("merges global MCP timeouts with project servers and lets the project override them", async () => {
    // Intent: timeout defaults are useful independently from server declarations,
    // so global and project files must merge both scalars alongside server entries.
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async (globalPath) => {
      await writeFile(globalPath, JSON.stringify({ mcp: { startupTimeoutMs: 80, callTimeoutMs: 90 } }), "utf8");
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({
        mcp: {
          servers: { mm: { type: "local", command: ["mock-mcp"], callTimeoutMs: 30 } },
        },
      }), "utf8");

      const inherited = loadPiBaseSettings(root);
      expect(inherited.settings.mcp?.startupTimeoutMs).toBe(80);
      expect(inherited.settings.mcp?.callTimeoutMs).toBe(90);
      expect(inherited.settings.mcp?.servers?.mm?.callTimeoutMs).toBe(30);

      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({
        mcp: {
          startupTimeoutMs: 40,
          callTimeoutMs: 45,
          servers: { mm: { type: "local", command: ["mock-mcp"] } },
        },
      }), "utf8");
      const overridden = loadPiBaseSettings(root);
      expect(overridden.settings.mcp?.startupTimeoutMs).toBe(40);
      expect(overridden.settings.mcp?.callTimeoutMs).toBe(45);
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

  it("expands HOME shortcuts in PI_BASE_GLOBAL_SETTINGS_PATH", async () => {
    // Intent: launcher-provided literal env overrides should resolve the same
    // HOME shortcuts as the rest of the config surface.
    const root = await createTempWorkspace();
    const previous = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
    const globalDir = join(homedir(), `.pi-base-global-${process.pid}-${Date.now()}`);
    const globalPath = join(globalDir, "pi-base.json");
    const relativeToHome = globalPath.slice(homedir().length + 1).replace(/\\/g, "/");
    try {
      await mkdir(globalDir, { recursive: true });
      await writeFile(globalPath, JSON.stringify({ notify: { agentEnd: true } }), "utf8");
      process.env.PI_BASE_GLOBAL_SETTINGS_PATH = `~/${relativeToHome}`;
      const loaded = loadPiBaseSettings(root);
      expect(loaded.globalPath).toBe(globalPath);
      expect(loaded.settings.notify?.agentEnd).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
      else process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previous;
      await rm(globalDir, { recursive: true, force: true });
    }
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

  it("normalizes jdtls workspaceData baseDir and validates mode", async () => {
    // Intent: workspaceData is passed to jdtls command enhancement, so config
    // loading must normalize HOME shortcuts before the resolver sees it.
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(
        join(projectDir, "pi-base.json"),
        JSON.stringify({
          lsp: {
            servers: {
              java: {
                command: ["jdtls"],
                extensions: [".java"],
                workspaceData: { mode: "process", baseDir: "$HOME/.cache/pi-base-jdtls" },
              },
            },
          },
        }),
        "utf8",
      );
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.lsp?.servers?.java?.workspaceData).toEqual({
        mode: "process",
        baseDir: join(homedir(), ".cache", "pi-base-jdtls"),
      });
    });
  });

  it("rejects invalid jdtls workspaceData values", async () => {
    // Intent: invalid modes would silently pick an unsafe workspace strategy;
    // rejecting at config load keeps the LSP lifecycle deterministic.
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(
        join(projectDir, "pi-base.json"),
        JSON.stringify({ lsp: { servers: { java: { command: ["jdtls"], extensions: [".java"], workspaceData: { mode: "session" } } } } }),
        "utf8",
      );
      expect(() => loadPiBaseSettings(root)).toThrowError(/workspaceData\.mode/);
    });
  });

  it.each([
    ["non-object root", null, /settings must be a JSON object/],
    ["invalid lsp shape", { lsp: [] }, /lsp must be an object/],
    ["invalid lsp servers shape", { lsp: { servers: [] } }, /lsp\.servers must be an object keyed by server id/],
    ["invalid lsp entry", { lsp: { servers: { ts: [] } } }, /lsp\.servers\.ts must be an object/],
    ["invalid lsp command", { lsp: { servers: { ts: { command: "ts", extensions: [".ts"] } } } }, /command must be an array of strings/],
    ["empty lsp command", { lsp: { servers: { ts: { command: [], extensions: [".ts"] } } } }, /command must contain at least one entry/],
    ["empty lsp extensions", { lsp: { servers: { ts: { command: ["ts"], extensions: [] } } } }, /extensions must contain at least one entry/],
    ["invalid lsp timeout", { lsp: { servers: { ts: { command: ["ts"], extensions: [".ts"], requestTimeoutMs: 0 } } } }, /requestTimeoutMs/],
    ["invalid workspaceData object", { lsp: { servers: { ts: { command: ["ts"], extensions: [".ts"], workspaceData: [] } } } }, /workspaceData must be an object/],
    ["invalid workspaceData baseDir", { lsp: { servers: { ts: { command: ["ts"], extensions: [".ts"], workspaceData: { baseDir: "" } } } } }, /workspaceData\.baseDir/],
    ["invalid permission shape", { permission: [] }, /permission must be/],
    ["invalid permission rule", { permission: { bash: { "*": "maybe" } } }, /permission\.bash\.\*/],
    ["invalid render shape", { render: [] }, /render must be an object/],
    ["invalid render lines", { render: { collapsedToolResultLines: -1 } }, /collapsedToolResultLines/],
    ["invalid render line map", { render: { collapsedToolResultLines: { read: 1.5 } } }, /collapsedToolResultLines\.read/],
    ["invalid render chars", { render: { collapsedToolResultMaxChars: { read: -1 } } }, /collapsedToolResultMaxChars\.read/],
    ["invalid notify boolean", { notify: { permissionAsked: "yes" } }, /notify\.permissionAsked/],
    ["invalid notify suppression", { notify: { suppressCompletedAfterRejectionMs: -1 } }, /suppressCompletedAfterRejectionMs/],
    ["invalid context compression shape", { contextCompression: [] }, /contextCompression must be an object/],
    ["invalid context compression rounds", { contextCompression: { retainedUserMessageRounds: 0 } }, /retainedUserMessageRounds/],
    ["invalid context compression tools", { contextCompression: { tools: [""] } }, /empty tool name/],
    ["invalid enabled providers", { contextCompression: { enabledProviders: "openai" } }, /enabledProviders must be an array of strings/],
    ["invalid disabled providers", { contextCompression: { disabledProviders: ["  "] } }, /disabledProviders/],
    ["invalid mcp shape", { mcp: [] }, /mcp must be an object/],
    ["invalid mcp servers", { mcp: { servers: null } }, /mcp\.servers must be an object/],
    ["empty mcp server key", { mcp: { servers: { "": { type: "local", command: ["x"] } } } }, /empty server name/],
    ["invalid mcp server type", { mcp: { servers: { x: { type: "stdio", command: ["x"] } } } }, /type must be either/],
    ["empty local command", { mcp: { servers: { x: { type: "local", command: [] } } } }, /command must contain at least one entry/],
    ["invalid local env", { mcp: { servers: { x: { type: "local", command: ["x"], env: { A: 1 } } } } }, /env\.A must be a string/],
    ["invalid local cwd", { mcp: { servers: { x: { type: "local", command: ["x"], cwd: 1 } } } }, /cwd must be a string/],
    ["invalid local startup timeout", { mcp: { servers: { x: { type: "local", command: ["x"], startupTimeoutMs: 0 } } } }, /startupTimeoutMs/],
    ["invalid local call timeout", { mcp: { servers: { x: { type: "local", command: ["x"], callTimeoutMs: 0 } } } }, /callTimeoutMs/],
    ["invalid global startup timeout", { mcp: { startupTimeoutMs: 0 } }, /mcp\.startupTimeoutMs/],
    ["invalid global call timeout", { mcp: { callTimeoutMs: -1 } }, /mcp\.callTimeoutMs/],
    ["invalid remote url type", { mcp: { servers: { x: { type: "remote", transport: "sse", url: 1 } } } }, /url must be a string/],
    ["invalid remote transport", { mcp: { servers: { x: { type: "remote", transport: "http", url: "https://example.com" } } } }, /transport/],
    ["invalid remote url", { mcp: { servers: { x: { type: "remote", transport: "sse", url: "not a url" } } } }, /url must be a valid URL/],
    ["invalid remote headers", { mcp: { servers: { x: { type: "remote", transport: "sse", url: "https://example.com", headers: [] } } } }, /headers must be an object/],
    ["invalid remote call timeout", { mcp: { servers: { x: { type: "remote", transport: "sse", url: "https://example.com", callTimeoutMs: 1.5 } } } }, /callTimeoutMs/],
    ["invalid yolo", { yolo: "yes" }, /yolo must be a boolean/],
    ["invalid defaultAgent", { defaultAgent: "   " }, /defaultAgent must be a non-empty string/],
  ])("rejects invalid config: %s", async (_name, settings, expected) => {
    // Intent: invalid pi-base.json files should fail at load time with
    // actionable paths, because users otherwise only see extension startup
    // failures after /reload.
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify(settings), "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(expected);
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
  it("omits suppressCompletedAfterRejectionMs from the loaded notify config when not set", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({
        notify: { permissionAsked: true },
      }), "utf8");
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.notify?.permissionAsked).toBe(true);
      expect(loaded.settings.notify?.suppressCompletedAfterRejectionMs).toBeUndefined();
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

  it("loads defaultAgent from unified pi-base config and lets project settings override it", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi");
    await mkdir(projectDir, { recursive: true });
    await withTempGlobalSettings(async (globalPath) => {
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, JSON.stringify({ defaultAgent: "reviewer" }), "utf8");
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({ defaultAgent: "planner" }), "utf8");
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.defaultAgent).toBe("planner");
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
          enabledProviders: ["openai", "google"],
          disabledProviders: ["xai"],
        },
      }), "utf8");
      await writeFile(join(projectDir, "pi-base.json"), JSON.stringify({
        contextCompression: {
          anchorHygiene: false,
          retainedAssistantTurns: 6,
          tools: ["bash", "read"],
          enabledProviders: ["openai"],
        },
      }), "utf8");
      const loaded = loadPiBaseSettings(root);
      expect(loaded.settings.contextCompression).toEqual({
        anchorHygiene: false,
        retainedUserMessageRounds: 4,
        retainedAssistantTurns: 6,
        tools: ["bash", "read"],
        enabledProviders: ["openai"],
        disabledProviders: ["xai"],
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
