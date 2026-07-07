import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import piBaseExtension, { registerFindTool } from "../index.js";
import { registerGrepTool } from "../src/grep.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

function requiredParams(tool: any): string[] {
  return Array.isArray(tool.parameters?.required) ? tool.parameters.required : [];
}

describe("workdir defaults", () => {
  it("declares workdir as optional for all cwd-scoped tools", () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const scopedTools = [
      "read",
      "grep",
      "find",
      "bash",
      "edit",
      "write",
      "lsp_diagnostics",
      "lsp_goto_definition",
      "lsp_workspace_symbols",
      "lsp_java_decompile",
    ];

    for (const name of scopedTools) {
      const tool = registry.getTool(name);
      expect(tool.parameters?.properties?.workdir, name).toBeTruthy();
      expect(requiredParams(tool), name).not.toContain("workdir");
    }
  });

  it("uses the current cwd when workdir is omitted for read, write, and edit", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\n");

    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const readText = getText(readResult);
    expect(readResult.isError).not.toBe(true);
    expect(readText).toContain("1|alpha");

    const editResult = await registry.getTool("edit").execute(
      "2",
      { workdir: ".", path: "src/example.ts", old_string: "alpha", new_string: "beta" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(editResult.isError).not.toBe(true);
    expect(await readFile(join(root, "src/example.ts"), "utf8")).toContain("beta");

    const writeResult = await registry.getTool("write").execute("3", { path: "src/new.ts", content: "created\n" }, undefined, undefined, { cwd: root });
    expect(writeResult.isError).not.toBe(true);
    expect(await readFile(join(root, "src/new.ts"), "utf8")).toBe("created\n");
  });

  it("omits default workdir details from find call previews", () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const component = registry.getTool("find").renderCall(
      { pattern: "*.ts", path: "src", timeout_seconds: 5 },
      {} as any,
      { lastComponent: undefined },
    ) as any;
    const rendered = component.render(200).join("\n");

    expect(rendered).toContain("find *.ts in src [timeout_seconds=5]");
    expect(rendered).not.toContain("(default)");
  });

  it("resolves read, write, and edit paths against an explicit workdir", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "repo/src/example.ts", "alpha\n");

    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const readResult = await registry.getTool("read").execute("1", { path: "src/example.ts", workdir: "repo" }, undefined, undefined, { cwd: root });
    const readText = getText(readResult);
    expect(readResult.isError).not.toBe(true);
    expect(readText).toContain("1|alpha");

    const editResult = await registry.getTool("edit").execute(
      "2",
      { workdir: "repo", path: "src/example.ts", old_string: "alpha", new_string: "beta" },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(editResult.isError).not.toBe(true);
    expect(await readFile(join(root, "repo/src/example.ts"), "utf8")).toContain("beta");

    const writeResult = await registry.getTool("write").execute("3", { path: "src/new.ts", workdir: "repo", content: "created\n" }, undefined, undefined, { cwd: root });
    expect(writeResult.isError).not.toBe(true);
    expect(await readFile(join(root, "repo/src/new.ts"), "utf8")).toBe("created\n");
  });

  it("uses the current cwd when delegating grep and find without workdir", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.ts", "alpha\n");

    const grepRegistry = createToolRegistry();
    let seenGrepCwd: string | undefined;
    let seenGrepParams: any;
    registerGrepTool(grepRegistry.pi as any, {
      createBuiltInGrepTool: (cwd) => {
        seenGrepCwd = cwd;
        return {
          execute: async (_id: string, params: any) => {
            seenGrepParams = params;
            return { content: [{ type: "text" as const, text: "ok" }] };
          },
        };
      },
    });

    const grepResult = await grepRegistry.getTool("grep").execute("1", { pattern: "alpha", path: "src" }, undefined, undefined, { cwd: root });
    expect(grepResult.isError).not.toBe(true);
    expect(seenGrepCwd).toBe(root);
    expect(seenGrepParams).toMatchObject({ pattern: "alpha", path: "src" });
    expect(seenGrepParams.workdir).toBeUndefined();

    const findRegistry = createToolRegistry();
    let seenFindCwd: string | undefined;
    let seenFindParams: any;
    registerFindTool(findRegistry.pi as any, (cwd) => {
      seenFindCwd = cwd;
      return {
        name: "find",
        label: "Find",
        description: "test find",
        parameters: {},
        execute: async (_id: string, params: any) => {
          seenFindParams = params;
          return { content: [{ type: "text" as const, text: "ok" }] };
        },
      };
    });

    const findResult = await findRegistry.getTool("find").execute("1", { pattern: "*.ts", path: "src" }, undefined, undefined, { cwd: root });
    expect(findResult.isError).not.toBe(true);
    expect(seenFindCwd).toBe(root);
    expect(seenFindParams).toEqual({ pattern: "*.ts", path: "src" });
  });

  it("uses the explicit workdir when delegating grep and find", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "repo/src/example.ts", "alpha\n");

    const grepRegistry = createToolRegistry();
    let seenGrepCwd: string | undefined;
    let seenGrepParams: any;
    registerGrepTool(grepRegistry.pi as any, {
      createBuiltInGrepTool: (cwd) => {
        seenGrepCwd = cwd;
        return {
          execute: async (_id: string, params: any) => {
            seenGrepParams = params;
            return { content: [{ type: "text" as const, text: "ok" }] };
          },
        };
      },
    });

    const grepResult = await grepRegistry.getTool("grep").execute("1", { pattern: "alpha", path: "src", workdir: "repo" }, undefined, undefined, { cwd: root });
    expect(grepResult.isError).not.toBe(true);
    expect(seenGrepCwd).toBe(join(root, "repo"));
    expect(seenGrepParams).toMatchObject({ pattern: "alpha", path: "src" });
    expect(seenGrepParams.workdir).toBeUndefined();

    const findRegistry = createToolRegistry();
    let seenFindCwd: string | undefined;
    let seenFindParams: any;
    registerFindTool(findRegistry.pi as any, (cwd) => {
      seenFindCwd = cwd;
      return {
        name: "find",
        label: "Find",
        description: "test find",
        parameters: {},
        execute: async (_id: string, params: any) => {
          seenFindParams = params;
          return { content: [{ type: "text" as const, text: "ok" }] };
        },
      };
    });

    const findResult = await findRegistry.getTool("find").execute("1", { pattern: "*.ts", path: "src", workdir: "repo" }, undefined, undefined, { cwd: root });
    expect(findResult.isError).not.toBe(true);
    expect(seenFindCwd).toBe(join(root, "repo"));
    expect(seenFindParams).toEqual({ pattern: "*.ts", path: "src" });
  });
});
