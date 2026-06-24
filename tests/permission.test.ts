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
  it("shows compact arguments before write and only offers Yes/No", async () => {
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
    expect(prompts[0]!.title).toContain(`Workdir: ${root} (default)`);
    expect(prompts[0]!.title).toContain("Arguments: ");
    expect(prompts[0]!.title).toContain("\"path\":\"src/allowed.ts\"");
    expect(prompts[0]!.title).toContain("\"content\":\"export const allowed = true;\\n\"");
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
      { workdir: ".", path: "src/blocked.ts", content: "export const blocked = true;\n" },
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
      { workdir: ".", path: "src/matched.ts", content: "export const matched = true;\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(allowed.isError).not.toBe(true);
    expect(prompts).toHaveLength(0);

    const asked = await registry.getTool("write").execute(
      "2",
      { workdir: ".", path: "notes.txt", content: "hello\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(asked.isError).not.toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Tool: write");
    expect(prompts[0]).toContain("Workdir: ");
    expect(prompts[0]).toContain("Arguments: ");
    expect(prompts[0]).toContain("\"path\":\"notes.txt\"");
  });
  // Intent: edit permission must resolve targets from hashline section headers, not only input.path.
  it("asks for edit when hashline patch paths do not match allow rules", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "secret.ts"), "old\n", "utf8");
    await writeProjectSettings(root, {
      permission: {
        edit: {
          "*": "ask",
          "src/public.ts": "allow",
        },
      },
    });
    const prompts: string[] = [];
    const registry = createToolRegistry({ hasUI: true });
    registry.setUI({
      select: async (title) => {
        prompts.push(title);
        return "No";
      },
    });
    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });
    const readResult = await registry.getTool("read").execute("1", { workdir: ".", path: "src/secret.ts" }, undefined, undefined, { cwd: root });
    const header = getText(readResult).split("\n").find((line) => /^\[[^#\r\n]+#[0-9A-F]{4}\]$/i.test(line));
    expect(header).toBeTruthy();
    const result = await registry.getTool("edit").execute(
      "2",
      { workdir: ".", input: `${header}\nSWAP 1.=1:\n+new` },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Permission denied by user");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Tool: edit");
    expect(prompts[0]).toContain("src/secret.ts");
  });
  it("matches path permission rules relative to the explicit workdir", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: {
        write: {
          "*": "ask",
          "repo/src/*.ts": "allow",
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
      { path: "src/matched.ts", workdir: "repo", content: "export const matched = true;\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(allowed.isError).not.toBe(true);
    expect(prompts).toHaveLength(0);
    expect(await readFile(join(root, "repo/src/matched.ts"), "utf8")).toBe("export const matched = true;\n");

    const asked = await registry.getTool("write").execute(
      "2",
      { path: "notes.txt", workdir: "repo", content: "hello\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(asked.isError).not.toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Workdir: repo");
    expect(prompts[0]).toContain("\"workdir\":\"repo\"");
  });

  it("toggles yolo mode via /yolo and bypasses permission checks", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, { permission: { write: "ask" }, contextCompression: { anchorHygiene: true } });
    await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true } }), "utf8");

    const registry = createToolRegistry({ hasUI: true });
    registry.setUI({
      select: async () => "No",
    });

    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const blocked = await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/yolo.ts", content: "export const yolo = false;\n" },
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
      { workdir: ".", path: "src/yolo.ts", content: "export const yolo = true;\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(allowed.isError).not.toBe(true);
    expect(await readFile(join(root, "src/yolo.ts"), "utf8")).toBe("export const yolo = true;\n");

    await registry.runCommand("yolo", "", { cwd: root });
    expect(registry.getStatuses().get("pi-base-permission")).toBeUndefined();
    expect(registry.renderFooter(120).join("\n")).not.toContain("YOLO");
  });

  it("applies configured default yolo mode when workspace settings first load", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, { permission: { write: "ask" }, yolo: true, contextCompression: { anchorHygiene: true } });
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
      { workdir: ".", path: "src/default-yolo.ts", content: "export const enabled = true;\n" },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).not.toBe(true);
    expect(await readFile(join(root, "src/default-yolo.ts"), "utf8")).toBe("export const enabled = true;\n");
  });
  it("refreshes cached settings only after session_start reload", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, { permission: { write: "deny" } });

    const registry = createToolRegistry({ hasUI: false });
    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const deniedBeforeChange = await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/reload.ts", content: "export const value = 1;\n" },
      undefined,
      undefined,
      { cwd: root, hasUI: false },
    );
    expect(deniedBeforeChange.isError).toBe(true);
    expect(getText(deniedBeforeChange)).toContain("Permission denied for write");
    expect(getText(deniedBeforeChange)).toContain("run /reload for the change to take effect");

    await writeProjectSettings(root, { permission: { write: "allow" } });

    const deniedBeforeReload = await registry.getTool("write").execute(
      "2",
      { workdir: ".", path: "src/reload.ts", content: "export const value = 2;\n" },
      undefined,
      undefined,
      { cwd: root, hasUI: false },
    );
    expect(deniedBeforeReload.isError).toBe(true);

    await registry.emit("session_start", { reason: "reload" }, { cwd: root });

    const allowedAfterReload = await registry.getTool("write").execute(
      "3",
      { workdir: ".", path: "src/reload.ts", content: "export const value = 3;\n" },
      undefined,
      undefined,
      { cwd: root, hasUI: false },
    );
    expect(allowedAfterReload.isError).not.toBe(true);
    expect(await readFile(join(root, "src/reload.ts"), "utf8")).toBe("export const value = 3;\n");
  });
  it("reloads yolo runtime mode from pi-base settings", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, { permission: { write: "ask" }, yolo: false });

    const registry = createToolRegistry({ hasUI: true });
    registry.setUI({ select: async () => "No" });
    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    await registry.runCommand("yolo", "", { cwd: root });
    expect(registry.getStatuses().get("pi-base-permission")).toBe("YOLO");

    await writeProjectSettings(root, { permission: { write: "ask" }, yolo: false });
    await registry.emit("session_start", { reason: "reload" }, { cwd: root });
    expect(registry.getStatuses().get("pi-base-permission")).toBeUndefined();

    const blocked = await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/reload-yolo.ts", content: "export const value = true;\n" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(blocked.isError).toBe(true);
    expect(getText(blocked)).toContain("Permission denied by user for write");
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
    expect(prompts[0]).toContain("Workdir: .");
    expect(prompts[0]).toContain("Arguments: ");
    expect(prompts[0]).toContain("\"command\":\"npm test\"");
    expect(prompts[0]).toContain("\"workdir\":\".\"");
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
    expect(prompts[0]).toContain("Tool: bash");
    expect(prompts[0]).toContain("Workdir: .");
    expect(prompts[0]).toContain("Arguments: ");
    expect(prompts[0]).toContain("pwd && ls -ld . && touch a.py");
  });
  it("uses quote-aware bash segments for static surface permission matching", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: {
        bash: {
          "*": "ask",
          "echo *": "allow",
          "grep *": "allow",
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
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const result = await registry.getTool("bash").execute(
      "1",
      { command: "echo 'a && b; c | d' && echo a\\;b | grep a", workdir: "." },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).not.toBe(true);
    expect(prompts).toHaveLength(0);
  });

  it("matches bash executable candidates after environment assignment prefixes", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: {
        bash: {
          "*": "ask",
          "npm *": "allow",
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
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const result = await registry.getTool("bash").execute(
      "1",
      { command: "NODE_ENV=test DEBUG=pi-base npm test", workdir: "." },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).not.toBe(true);
    expect(prompts).toHaveLength(0);
  });
  it("applies bash permission rules to commands after background separators", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: {
        bash: {
          "*": "ask",
          "sleep *": "allow",
          "rm *": "deny",
        },
      },
    });

    const registry = createToolRegistry({ hasUI: true });
    piBaseExtension(registry.pi as any);
    registerBashRendererTool(registry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "should not run" }] }) }),
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const result = await registry.getTool("bash").execute(
      "1",
      { command: "sleep 1 & rm -rf tmp", workdir: "." },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Permission denied for bash");
  });

  it("does not inspect runtime bash content inside static shell wrappers", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: {
        bash: {
          "*": "ask",
          "rm *": "deny",
          "bash *": "allow",
          "echo *": "allow",
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
      createBuiltInBashTool: () => ({ execute: async (_toolCallId: string, params: any) => ({ content: [{ type: "text", text: `ran ${params.command}` }] }) }),
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const wrapped = await registry.getTool("bash").execute(
      "1",
      { command: "bash -c \"$REAL_BASH\"", workdir: "." },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(wrapped.isError).not.toBe(true);

    const substitution = await registry.getTool("bash").execute(
      "2",
      { command: "echo \"$(rm -rf tmp)\"", workdir: "." },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(substitution.isError).not.toBe(true);
    expect(prompts).toHaveLength(0);
  });
  it("does not treat heredoc body text as separate bash permission commands", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: {
        bash: {
          "*": "ask",
          "rm *": "deny",
          "cat *": "allow",
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
      createBuiltInBashTool: () => ({ execute: async (_toolCallId: string, params: any) => ({ content: [{ type: "text", text: `ran ${params.command}` }] }) }),
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const result = await registry.getTool("bash").execute(
      "1",
      { command: "cat <<'EOF'\nrm -rf tmp\nEOF", workdir: "." },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).not.toBe(true);
    expect(prompts).toHaveLength(0);
  });

  it("asks instead of guessing when bash surface syntax is malformed", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, {
      permission: {
        bash: {
          "*": "ask",
          "echo *": "allow",
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
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const result = await registry.getTool("bash").execute(
      "1",
      { command: "echo 'unterminated", workdir: "." },
      undefined,
      undefined,
      { cwd: root },
    );

    const deniedRoot = await createTempWorkspace();
    await writeProjectSettings(deniedRoot, { permission: { bash: { "*": "deny" } } });
    const deniedRegistry = createToolRegistry({ hasUI: true });
    deniedRegistry.setUI({ select: async () => "Yes" });
    piBaseExtension(deniedRegistry.pi as any);
    registerBashRendererTool(deniedRegistry.pi as any, {
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "should not run" }] }) }),
    });
    await deniedRegistry.emit("session_start", { reason: "startup" }, { cwd: deniedRoot });
    const denied = await deniedRegistry.getTool("bash").execute(
      "2",
      { command: "echo 'unterminated", workdir: "." },
      undefined,
      undefined,
      { cwd: deniedRoot },
    );
    expect(denied.isError).toBe(true);
    expect(getText(denied)).toContain("Permission denied for bash");
    expect(result.isError).not.toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("echo 'unterminated");
  });

  it("keeps bash permission argument previews single-line and truncated for long commands", async () => {
    const root = await createTempWorkspace();
    await writeProjectSettings(root, { permission: { bash: "ask" } });

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
      createBuiltInBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }),
    });
    await registry.emit("session_start", { reason: "startup" }, { cwd: root });

    const longCommand = [
      "cat > /tmp/TestDebug.java << 'EOF'",
      "public class TestDebug {",
      "  public static void main(String[] args) {",
      "    System.out.println(\"debug\");",
      "  }",
      "}",
      "EOF",
      "javac /tmp/TestDebug.java && java -cp /tmp TestDebug",
    ].join("\n");

    const result = await registry.getTool("bash").execute(
      "1",
      { command: longCommand, workdir: "." },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).not.toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Tool: bash");
    const promptLines = prompts[0]!.split("\n");
    const argumentLines = promptLines.filter((line) => line.startsWith("Arguments: "));
    expect(argumentLines).toHaveLength(1);
    expect(argumentLines[0]).toContain("TestDebug");
    expect(argumentLines[0]).toContain("...");
    expect(promptLines.length).toBeLessThanOrEqual(7);
  });
});
