import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBestJavaHome, LspDiscoveryResolver, type LspServerConfig } from "../src/lsp/discovery.js";
import { createTempWorkspace } from "./helpers.js";

const JAVA_HOME_ENVIRONMENT_KEY = /^JAVA_HOME(?:_\d+)?$/i;

function javaHomeEnvironmentEntries(): Array<[string, string | undefined]> {
  return Object.entries(process.env)
    .filter(([key]) => JAVA_HOME_ENVIRONMENT_KEY.test(key));
}

function clearJavaHomeEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (JAVA_HOME_ENVIRONMENT_KEY.test(key)) delete process.env[key];
  }
}

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

function javaServer(rootMarkers: string[], firstMatchMarkers: string[]): LspServerConfig {
  return {
    id: "java",
    command: [],
    extensions: [".java"],
    rootMarkers,
    firstMatchMarkers,
  };
}

describe("LspDiscoveryResolver workspace roots", () => {
  it("prefers the topmost build root over a closer first-match marker", async () => {
    // Intent: multi-module language servers must start at the outer build root even when a
    // closer marker exists beside the source file.
    const repository = await createTempWorkspace();
    const project = join(repository, "project");
    const moduleDir = join(project, "modules", "app");
    const filePath = join(moduleDir, "src", "Main.java");
    await mkdir(join(repository, ".git"));
    await mkdir(join(moduleDir, "src"), { recursive: true });
    await writeFile(join(project, "pom.xml"), "<project />");
    await writeFile(join(moduleDir, "pom.xml"), "<project />");
    await writeFile(join(moduleDir, "package.json"), "{}");
    await writeFile(filePath, "class Main {}");

    const resolver = new LspDiscoveryResolver({});
    expect(resolver.findWorkspaceRoot(filePath, javaServer(["pom.xml"], ["package.json"]))).toBe(project);
  });

  it("does not let markers outside a git worktree hijack its project root", async () => {
    // Intent: a linked worktree has a `.git` file, not a directory; ancestor build markers from
    // the main checkout must not become the worktree's LSP root.
    const outer = await createTempWorkspace();
    const worktree = join(outer, "linked-worktree");
    const filePath = join(worktree, "src", "Main.java");
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(outer, "pom.xml"), "<project />");
    await writeFile(join(worktree, ".git"), "gitdir: ../.git/worktrees/linked");
    await writeFile(join(worktree, "package.json"), "{}");
    await writeFile(filePath, "class Main {}");

    const resolver = new LspDiscoveryResolver({});
    expect(resolver.findWorkspaceRoot(filePath, javaServer(["pom.xml"], ["package.json"]))).toBe(worktree);
  });
});

describe("findBestJavaHome", () => {
  it("selects the highest configured existing JDK and ignores missing paths", async () => {
    // Intent: jdtls startup must use deterministic version priority rather than whichever
    // JAVA_HOME variable happens to appear first in the process environment.
    const original = javaHomeEnvironmentEntries();
    const root = await createTempWorkspace();
    const java17 = join(root, "jdk-17");
    const java26 = join(root, "jdk-26");
    await mkdir(java17);
    await mkdir(java26);

    try {
      clearJavaHomeEnvironment();
      expect(findBestJavaHome()).toBeNull();

      process.env.JAVA_HOME_99 = join(root, "missing-jdk-99");
      process.env.JAVA_HOME_17 = java17;
      process.env.JAVA_HOME_26 = java26;
      process.env.JAVA_HOME = java17;
      expect(findBestJavaHome()).toBe(java26);
    } finally {
      clearJavaHomeEnvironment();
      for (const [key, value] of original) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });
});

describe("LspDiscoveryResolver command discovery", () => {
  it("requires explicit Windows executable suffixes", async () => {
    // Intent: a regular text file must not be reported as an installed LSP server on Windows.
    const root = await createTempWorkspace();
    const textFile = join(root, "server.txt");
    const commandFile = join(root, "server.cmd");
    const pathCommandFile = join(root, "path-server.CMD");
    await writeFile(textFile, "not executable");
    await writeFile(commandFile, "@echo off\r\n");
    await writeFile(pathCommandFile, "@echo off\r\n");
    const previousPathExt = process.env.PATHEXT;
    const previousPath = process.env.PATH;

    try {
      process.env.PATHEXT = "EXE;CMD;BAT;COM";
      process.env.PATH = root;
      await withPlatform("win32", () => {
        const resolver = new LspDiscoveryResolver({});
        expect(resolver.findCommandPath(textFile)).toBeNull();
        expect(resolver.findCommandPath(commandFile)).toBe(commandFile);
        expect(resolver.findCommandPath("path-server")).toBe(pathCommandFile);
      });
    } finally {
      if (previousPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = previousPathExt;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
