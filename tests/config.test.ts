import { describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
    const projectDir = join(root, ".pi", "pi-base");
    await mkdir(projectDir, { recursive: true });
    const projectPath = join(projectDir, "settings.json");
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
    const projectDir = join(root, ".pi", "pi-base");
    const childDir = join(root, "packages", "app", "src");
    await mkdir(projectDir, { recursive: true });
    await mkdir(childDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(join(projectDir, "settings.json"), JSON.stringify({ lsp: { searchPaths: ["/repo-root/bin"] } }), "utf8");
      const loaded = loadPiBaseSettings(childDir);
      expect(loaded.projectPath).toBe(join(projectDir, "settings.json"));
      expect(loaded.settings.lsp?.searchPaths).toEqual(["/repo-root/bin"]);
    });
  });

  it("resolves relative project searchPaths and command paths against the settings file directory", async () => {
    const root = await createTempWorkspace();
    const projectDir = join(root, ".pi", "pi-base");
    const childDir = join(root, "packages", "app");
    await mkdir(projectDir, { recursive: true });
    await mkdir(childDir, { recursive: true });
    await withTempGlobalSettings(async () => {
      await writeFile(
        join(projectDir, "settings.json"),
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
    expect(() => resolver.findServerForFile("/tmp/demo.ts")).toThrowError(/\.pi\/pi-base\/settings\.json/);
    expect(() => resolver.findServerForFile("/tmp/demo.ts")).toThrowError(/"typescript": \{/);
    expect(() => resolver.findServerForFile("/tmp/demo.ts")).toThrowError(/"\/absolute\/path\/to\/missing-ts-lsp"/);
  });

  it("surfaces malformed project settings", async () => {
    await withTempGlobalSettings(async () => {
      const root = await createTempWorkspace();
      const projectDir = join(root, ".pi", "pi-base");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "settings.json"), "{", "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(/Invalid pi-base settings at .*settings\.json/);
    });
  });

  it("surfaces invalid lsp server entries", async () => {
    await withTempGlobalSettings(async () => {
      const root = await createTempWorkspace();
      const projectDir = join(root, ".pi", "pi-base");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "settings.json"), JSON.stringify({ lsp: { servers: { ts: { command: "ts-lsp", extensions: [".ts"] } } } }), "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(/lsp\.servers\.ts\.command must be an array of strings/);
    });
  });

  it("surfaces invalid lsp blocks", async () => {
    await withTempGlobalSettings(async () => {
      const root = await createTempWorkspace();
      const projectDir = join(root, ".pi", "pi-base");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "settings.json"), JSON.stringify({ lsp: [] }), "utf8");
      expect(() => loadPiBaseSettings(root)).toThrowError(/lsp must be an object/);
    });
  });
});
