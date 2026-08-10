import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBestJavaHome, LspDiscoveryResolver, type LspServerConfig } from "../src/lsp/discovery.js";
import { createTempWorkspace } from "./helpers.js";

const JAVA_HOME_KEYS = [
  "JAVA_HOME_22",
  "JAVA_HOME_21",
  "JAVA_HOME_20",
  "JAVA_HOME_19",
  "JAVA_HOME_18",
  "JAVA_HOME_17",
  "JAVA_HOME_11",
  "JAVA_HOME_8",
  "JAVA_HOME",
] as const;

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
    const original = new Map(JAVA_HOME_KEYS.map((key) => [key, process.env[key]]));
    const root = await createTempWorkspace();
    const java17 = join(root, "jdk-17");
    const java21 = join(root, "jdk-21");
    await mkdir(java17);
    await mkdir(java21);

    try {
      for (const key of JAVA_HOME_KEYS) delete process.env[key];
      expect(findBestJavaHome()).toBeNull();

      process.env.JAVA_HOME_22 = join(root, "missing-jdk-22");
      process.env.JAVA_HOME_17 = java17;
      process.env.JAVA_HOME_21 = java21;
      process.env.JAVA_HOME = java17;
      expect(findBestJavaHome()).toBe(java21);
    } finally {
      for (const key of JAVA_HOME_KEYS) {
        const value = original.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
