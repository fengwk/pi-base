import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { clearSubagentPermissionHost } from "../src/subagent/permission-host.js";
import { DEPTH_ENTRY, ROOT_SESSION_ENTRY } from "../src/subagent/depth.js";
import { AGENT_STATE_ENTRY } from "../src/agent-support.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

function patch(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

async function writeSettings(root: string, permission: unknown): Promise<void> {
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ permission }), "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

let previousGlobalSettingsPath: string | undefined;

beforeEach(async () => {
  previousGlobalSettingsPath = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  const root = await createTempWorkspace();
  const globalPath = join(root, "global.json");
  await writeFile(globalPath, "{}", "utf8");
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalPath;
});

afterEach(() => {
  clearSubagentPermissionHost();
  if (previousGlobalSettingsPath === undefined) delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  else process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
});

describe("apply_patch permission integration", () => {
  it("inherits edit for updates and write for adds/deletes", async () => {
    // Intent: operation-specific inheritance prevents apply_patch from bypassing existing file rules.
    const root = await createTempWorkspace();
    await writeSettings(root, { edit: "deny", write: "allow" });
    await writeFile(join(root, "update.txt"), "old\n", "utf8");
    await writeFile(join(root, "delete.txt"), "gone\n", "utf8");
    const registry = createToolRegistry({ hasUI: false });
    piBaseExtension(registry.pi as any);

    const deniedUpdate = await registry.getTool("apply_patch").execute("update", {
      workdir: root,
      patchText: patch("*** Update File: update.txt", "@@", "-old", "+new"),
    }, undefined, undefined, { cwd: root, hasUI: false });
    expect(deniedUpdate.isError).toBe(true);
    expect(getText(deniedUpdate)).toContain("Permission denied for apply_patch");
    expect(await readFile(join(root, "update.txt"), "utf8")).toBe("old\n");

    const writeOperations = await registry.getTool("apply_patch").execute("write-ops", {
      workdir: root,
      patchText: patch("  *** Add File: add.txt  ", "+added", "\t*** Delete File: delete.txt\t"),
    }, undefined, undefined, { cwd: root, hasUI: false });
    expect(writeOperations.isError).not.toBe(true);
    expect(await readFile(join(root, "add.txt"), "utf8")).toBe("added\n");
    expect(await exists(join(root, "delete.txt"))).toBe(false);
  });

  it("lets permission.apply_patch override inherited operation rules", async () => {
    const root = await createTempWorkspace();
    await writeSettings(root, { edit: "deny", write: "deny", apply_patch: "allow" });
    await writeFile(join(root, "update.txt"), "old\n", "utf8");
    const registry = createToolRegistry({ hasUI: false });
    piBaseExtension(registry.pi as any);

    const result = await registry.getTool("apply_patch").execute("override", {
      workdir: root,
      patchText: patch(
        "*** Add File: add.txt",
        "+added",
        "*** Update File: update.txt",
        "@@",
        "-old",
        "+new",
      ),
    }, undefined, undefined, { cwd: root, hasUI: false });

    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "update.txt"), "utf8")).toBe("new\n");
  });

  it("aggregates valid targets as deny over ask over allow and prompts with compact targets", async () => {
    const root = await createTempWorkspace();
    await writeSettings(root, {
      edit: { "*": "allow", "ask.txt": "ask" },
      write: { "*": "allow", "deny.txt": "deny" },
    });
    await writeFile(join(root, "ask.txt"), "old\n", "utf8");
    await writeFile(join(root, "delete.txt"), "gone\n", "utf8");
    const prompts: string[] = [];
    const registry = createToolRegistry({ hasUI: true, ui: { select: async (title) => { prompts.push(title); return "Yes"; } } });
    piBaseExtension(registry.pi as any);

    const asked = await registry.getTool("apply_patch").execute("ask", {
      workdir: root,
      patchText: patch(
        "*** Add File: allow.txt",
        "+added",
        "*** Update File: ask.txt",
        "@@",
        "-old",
        "+new",
        "*** Delete File: delete.txt",
      ),
    }, undefined, undefined, { cwd: root });
    expect(asked.isError).not.toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Targets:\n  A allow.txt\n  M ask.txt\n  D delete.txt");
    expect(prompts[0]).toContain("Requested changes:");
    expect(prompts[0]).toContain("  A allow.txt\n  +added");
    expect(prompts[0]).toContain("  M ask.txt\n  @@\n  -old\n  +new");
    expect(prompts[0]).toContain("  D delete.txt\n  (delete file)");
    expect(prompts[0]).not.toContain("*** Begin Patch");

    const denied = await registry.getTool("apply_patch").execute("deny", {
      workdir: root,
      patchText: patch("*** Add File: okay.txt", "+ok", "*** Add File: deny.txt", "+no"),
    }, undefined, undefined, { cwd: root });
    expect(denied.isError).toBe(true);
    expect(getText(denied)).toContain("Permission denied for apply_patch");
    expect(prompts).toHaveLength(1);
    expect(await exists(join(root, "okay.txt"))).toBe(false);
  });

  it("bounds permission previews while preserving the complete target list", async () => {
    // Intent: requested-change content stays bounded without hiding any target
    // whose inherited and apply_patch permissions contributed to the decision.
    const root = await createTempWorkspace();
    await writeSettings(root, { apply_patch: "ask" });
    const prompts: string[] = [];
    const registry = createToolRegistry({
      hasUI: true,
      ui: { select: async (title) => { prompts.push(title); return "No"; } },
    });
    piBaseExtension(registry.pi as any);

    const result = await registry.getTool("apply_patch").execute("large-preview", {
      patchText: patch(
        "*** Add File: large.txt",
        ...Array.from({ length: 50 }, (_, index) => `+line-${index + 1}`),
      ),
    }, undefined, undefined, { cwd: root });

    expect(result.isError).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Targets:\n  A large.txt");
    expect(prompts[0]).toContain("  +line-1");
    expect(prompts[0]).toContain("more patch lines");
    expect(prompts[0]).not.toContain("+line-50");
    expect(await exists(join(root, "large.txt"))).toBe(false);
  });

  it("resolves target rules from workdir and keeps malformed patches non-mutating", async () => {
    const root = await createTempWorkspace();
    await writeSettings(root, {
      write: { "*": "deny", "repo/src/*.ts": "allow" },
      apply_patch: { "malformed-only": "deny" },
    });
    const registry = createToolRegistry({ hasUI: false });
    piBaseExtension(registry.pi as any);

    const allowed = await registry.getTool("apply_patch").execute("workdir", {
      workdir: "repo",
      patchText: patch("*** Add File: src/a.ts", "+export const a = 1;"),
    }, undefined, undefined, { cwd: root, hasUI: false });
    expect(allowed.isError).not.toBe(true);
    expect(await readFile(join(root, "repo/src/a.ts"), "utf8")).toBe("export const a = 1;\n");

    const malformed = await registry.getTool("apply_patch").execute("malformed", {
      workdir: root,
      patchText: "*** Begin Patch\n*** Add File: malformed-only\n+created",
    }, undefined, undefined, { cwd: root, hasUI: false });
    expect(malformed.isError).toBe(true);
    expect(getText(malformed)).toContain("Patch must end with");
    expect(await exists(join(root, "malformed-only"))).toBe(false);

    const deniedRoot = await createTempWorkspace();
    await writeSettings(deniedRoot, { apply_patch: "deny" });
    const deniedRegistry = createToolRegistry({ hasUI: false });
    piBaseExtension(deniedRegistry.pi as any);
    const genericallyDenied = await deniedRegistry.getTool("apply_patch").execute("malformed-deny", {
      patchText: "not a patch",
    }, undefined, undefined, { cwd: deniedRoot, hasUI: false });
    expect(genericallyDenied.isError).toBe(true);
    expect(getText(genericallyDenied)).toContain("Permission denied for apply_patch");
  });

  it("normalizes separators consistently before permission and patch execution", async () => {
    // Intent: permission must not authorize slash target X while apply_patch
    // creates a distinct POSIX filename Y containing literal backslashes.
    const root = await createTempWorkspace();
    await writeSettings(root, { write: { "*": "deny", "nested/*.txt": "allow" } });
    const registry = createToolRegistry({ hasUI: false });
    piBaseExtension(registry.pi as any);

    const result = await registry.getTool("apply_patch").execute("separator-alias", {
      workdir: root,
      patchText: patch("*** Add File: nested\\patch.txt", "+created"),
    }, undefined, undefined, { cwd: root, hasUI: false });

    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "nested", "patch.txt"), "utf8")).toBe("created\n");
    expect(await readdir(root)).not.toContain("nested\\patch.txt");
  });

  it("normalizes absolute dot segments before matching path permissions", async () => {
    // Intent: an absolute alias such as /safe/../blocked must not bypass a rule
    // written for the canonical lexical path used by the filesystem operation.
    const root = await createTempWorkspace();
    const blocked = join(root, "blocked.txt");
    await writeSettings(root, { write: { "*": "allow", [blocked]: "deny" } });
    const registry = createToolRegistry({ hasUI: false });
    piBaseExtension(registry.pi as any);

    const result = await registry.getTool("apply_patch").execute("absolute-alias", {
      patchText: patch(`*** Add File: ${root}/nested/../blocked.txt`, "+no"),
    }, undefined, undefined, { cwd: root, hasUI: false });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Permission denied for apply_patch");
    expect(await exists(blocked)).toBe(false);
  });

  it("preserves headless ask blocking, root-relayed subagent prompts, and yolo bypass", async () => {
    const root = await createTempWorkspace();
    await writeSettings(root, { apply_patch: "ask" });
    const patchText = patch("*** Add File: relayed.txt", "+ok");

    const headless = createToolRegistry({ hasUI: false });
    piBaseExtension(headless.pi as any);
    const blocked = await headless.getTool("apply_patch").execute("headless", { patchText, workdir: root }, undefined, undefined, { cwd: root, hasUI: false });
    expect(blocked.isError).toBe(true);
    expect(getText(blocked)).toContain("no interactive UI is available");

    const rootPrompts: string[] = [];
    const rootRegistry = createToolRegistry({ hasUI: true, cwd: root, ui: { select: async (title) => { rootPrompts.push(title); return "Yes"; } } });
    piBaseExtension(rootRegistry.pi as any);
    await rootRegistry.emit("session_start", { reason: "startup" }, { cwd: root, hasUI: true });

    const child = createToolRegistry({ hasUI: false, cwd: root });
    child.pi.appendEntry(DEPTH_ENTRY, { depth: 2 });
    child.pi.appendEntry(ROOT_SESSION_ENTRY, { rootSessionId: "test-session" });
    child.pi.appendEntry(AGENT_STATE_ENTRY, { name: "default" });
    piBaseExtension(child.pi as any);
    const relayed = await child.getTool("apply_patch").execute("child", { patchText, workdir: root }, undefined, undefined, { cwd: root, hasUI: false });
    expect(relayed.isError).not.toBe(true);
    expect(rootPrompts).toHaveLength(1);
    expect(rootPrompts[0]).toContain("subagent「default」(depth 2)");
    expect(rootPrompts[0]).toContain("A relayed.txt");

    await writeSettings(root, { apply_patch: "deny" });
    await rootRegistry.emit("session_start", { reason: "reload" }, { cwd: root, hasUI: true });
    await rootRegistry.runCommand("yolo", "", { cwd: root });
    const yolo = await rootRegistry.getTool("apply_patch").execute("yolo", {
      workdir: root,
      patchText: patch("*** Add File: yolo.txt", "+ok"),
    }, undefined, undefined, { cwd: root });
    expect(yolo.isError).not.toBe(true);
  });
});
