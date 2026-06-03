import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import piBaseExtension from "../index.js";
import { registerBashRendererTool } from "../src/bash-renderer.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

async function writeProjectSettings(root: string, settings: unknown): Promise<void> {
  const settingsDir = join(root, ".pi");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(join(settingsDir, "pi-base.json"), JSON.stringify(settings), "utf8");
}

let previousGlobalSettingsPath: string | undefined;

beforeEach(async () => {
  previousGlobalSettingsPath = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  const root = await createTempWorkspace();
  const globalPath = join(root, "global-pi-base.json");
  await writeFile(globalPath, JSON.stringify({}), "utf8");
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalPath;
});

afterEach(() => {
  if (previousGlobalSettingsPath === undefined) {
    delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  } else {
    process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
  }
});

describe("permission guard", () => {
  it("asks before write and only offers Yes/No", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, { permission: { write: "ask" } });

    const prompts: Array<{ title: string; items: string[] }> = [];
    const registry = createToolRegistry({ hasUI: true });
    registry.setUI({
      select: async (title, items) => {
        prompts.push({ title, items });
        return "Yes";
      },
    });

    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const result = await registry.getTool("write").execute(
      "1",
      { path: "src/allowed.ts", content: "export const allowed = true;\n" },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).not.toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.title).toContain("Tool: write");
    expect(prompts[0]!.title).toContain("Path: src/allowed.ts");
    expect(prompts[0]!.items).toEqual(["Yes", "No"]);
    expect(registry.getStatuses().get("pi-base-permission")).toBeUndefined();
    expect(await readFile(join(root, "src/allowed.ts"), "utf8")).toBe("export const allowed = true;\n");
  });

  it("blocks ask rules when there is no interactive UI", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, { permission: { write: "ask" } });

    const registry = createToolRegistry({ hasUI: false });
    piBaseExtension(registry.pi as any);

    const result = await registry.getTool("write").execute(
      "1",
      { path: "src/blocked.ts", content: "export const blocked = true;\n" },
      undefined,
      undefined,
      { cwd: root, hasUI: false },
    );

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("no interactive UI is available");
    expect(getText(result)).toContain(`${root}/.pi/pi-base.json`);
  });

  it("uses configured path patterns for automatic allowance and asks for unmatched files", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: {
        write: {
          "*": "ask",
          "src/*.ts": "allow",
        },
      },
    });

    const prompts: string[] = [];
    const registry = createToolRegistry({ hasUI: true });
    registry.setUI({
      select: async (title) => {
        prompts.push(title);
        return "Yes";
      },
    });

    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const allowed = await registry.getTool("write").execute(
      "1",
      { path: "src/matched.ts", content: "export const matched = true;\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(allowed.isError).not.toBe(true);
    expect(prompts).toHaveLength(0);

    const asked = await registry.getTool("write").execute(
      "2",
      { path: "notes.txt", content: "hello\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(asked.isError).not.toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Path: notes.txt");
  });

  it("toggles yolo mode via /yolo and bypasses permission checks", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, { permission: { write: "ask" } });
    await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true } }), "utf8");

    const registry = createToolRegistry({ hasUI: true });
    registry.setUI({
      select: async () => "No",
    });

    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const blocked = await registry.getTool("write").execute(
      "1",
      { path: "src/yolo.ts", content: "export const yolo = false;\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(blocked.isError).toBe(true);
    expect(getText(blocked)).toContain("Permission denied by user for write");

    await registry.runCommand("yolo", "", { cwd: root });
    expect(registry.getStatuses().get("pi-base-permission")).toBe("YOLO");
    const footerLines = registry.renderFooter(120);
    expect(footerLines).toHaveLength(2);
    expect(footerLines[1]).toContain("YOLO");
    expect(registry.renderFooter(4)).toEqual(["YOLO"]);

    registry.setUI({
      select: async () => {
        throw new Error("yolo mode should not prompt");
      },
    });

    const allowed = await registry.getTool("write").execute(
      "2",
      { path: "src/yolo.ts", content: "export const yolo = true;\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(allowed.isError).not.toBe(true);
    expect(await readFile(join(root, "src/yolo.ts"), "utf8")).toBe("export const yolo = true;\n");

    await registry.runCommand("yolo", "", { cwd: root });
    expect(registry.getStatuses().get("pi-base-permission")).toBeUndefined();
    expect(registry.renderFooter(120)).toEqual([]);
  });

  it("applies configured default yolo mode when a session has no prior yolo entry", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, { permission: { write: "ask" }, yolo: "enable" });
    await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true } }), "utf8");

    const registry = createToolRegistry({ hasUI: true });
    registry.setUI({
      select: async () => {
        throw new Error("default yolo mode should bypass prompts");
      },
    });

    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    expect(registry.getStatuses().get("pi-base-permission")).toBe("YOLO");
    const footerLines = registry.renderFooter(120);
    expect(footerLines).toHaveLength(2);
    expect(footerLines[1]).toContain("YOLO");

    const result = await registry.getTool("write").execute(
      "1",
      { path: "src/default-yolo.ts", content: "export const enabled = true;\n" },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "src/default-yolo.ts"), "utf8")).toBe("export const enabled = true;\n");
  });

  it("respects configured bash patterns and still asks for unmatched commands", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: {
        bash: {
          "*": "ask",
          "git *": "allow",
        },
      },
    });

    const prompts: string[] = [];
    const registry = createToolRegistry({ hasUI: true });
    registry.setUI({
      select: async (title) => {
        prompts.push(title);
        return "Yes";
      },
    });

    piBaseExtension(registry.pi as any);
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({
        execute: async (_toolCallId: string, params: any) => ({
          content: [{ type: "text", text: `ran ${params.command}` }],
        }),
      }),
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const gitResult = await registry.getTool("bash").execute(
      "1",
      { command: "git status --short", workdir: "." },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(gitResult.isError).not.toBe(true);
    expect(prompts).toHaveLength(0);

    const npmResult = await registry.getTool("bash").execute(
      "2",
      { command: "npm test", workdir: "." },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(npmResult.isError).not.toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Tool: bash");
    expect(prompts[0]).toContain("Command: npm test");
  });

  it("asks for composite bash commands even when early segments are allowlisted", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: {
        bash: {
          "*": "ask",
          "pwd *": "allow",
          "ls *": "allow",
        },
      },
    });

    const prompts: string[] = [];
    const registry = createToolRegistry({ hasUI: true });
    registry.setUI({
      select: async (title) => {
        prompts.push(title);
        return "Yes";
      },
    });

    piBaseExtension(registry.pi as any);
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({
        execute: async (_toolCallId: string, params: any) => ({
          content: [{ type: "text", text: `ran ${params.command}` }],
        }),
      }),
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const result = await registry.getTool("bash").execute(
      "1",
      { command: "pwd && ls -ld . && touch a.py", workdir: "." },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).not.toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Command: pwd && ls -ld . && touch a.py");
  });
});
