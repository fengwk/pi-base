import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerWriteTool } from "../src/write.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

function render(component: any): string {
  return component.render(200).join("\n");
}

describe("write behavior", () => {
  it("renders full multi-line write call previews with explicit workdir", () => {
    const registry = createToolRegistry();
    registerWriteTool(registry.pi as any);
    const rendered = render(registry.getTool("write").renderCall(
      { path: "src/example.ts", workdir: "services/api", content: "alpha\nbeta\n" },
      {} as any,
      { lastComponent: undefined },
    ));

    expect(rendered).toContain("write src/example.ts in services/api");
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("beta");
  });

  it("requires path and defaults workdir during execution", async () => {
    const registry = createToolRegistry();
    registerWriteTool(registry.pi as any);

    const missingPath = await registry.getTool("write").execute("1", { content: "x" }, undefined, undefined, { cwd: process.cwd() });
    expect(missingPath.isError).toBe(true);
    expect(getText(missingPath)).toContain("path is required");

    const root = await createTempWorkspace();
    const created = await registry.getTool("write").execute("2", { path: "x.ts", content: "x" }, undefined, undefined, { cwd: root });
    expect(created.isError).not.toBe(true);
    expect(await readFile(join(root, "x.ts"), "utf8")).toBe("x");
  });

  it("calls onSuccessfulWrite hook and reports overwrites", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/existing.ts", "old\n");
    const writes: string[] = [];
    const registry = createToolRegistry();
    registerWriteTool(registry.pi as any, {
      onSuccessfulWrite: (absolutePath) => writes.push(absolutePath),
    });

    const result = await registry.getTool("write").execute(
      "1",
      { workdir: ".", path: "src/existing.ts", content: "new\ncontent\n" },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(getText(result)).toContain("Overwrote src/existing.ts successfully.");
    expect(writes[0]).toContain("src/existing.ts");
  });
});
