import { describe, expect, it } from "vitest";
import { join } from "node:path";
import piBaseExtension from "../index.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

describe("find: path is required", () => {
  it("returns isError when path is missing", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("find").execute("1", { workdir: ".", pattern: "*.ts" }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/find requires an explicit `path`/);
  });

  it("returns isError when path is empty string", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("find").execute("1", { workdir: ".", pattern: "*.ts", path: "" }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/find requires an explicit `path`/);
  });

  it("returns isError when path is whitespace only", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("find").execute("1", { workdir: ".", pattern: "*.ts", path: "   " }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/find requires an explicit `path`/);
  });

  it("accepts an explicit '.' path", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("find").execute("1", { workdir: ".", pattern: "*.ts", path: "." }, undefined, undefined, { cwd: root });
    expect(result.isError).not.toBe(true);
    expect(getText(result)).not.toMatch(/find requires an explicit `path`/);
  });
});

describe("grep: binary files are rejected before upstream runs", () => {
  it("returns isError for a binary file path", async () => {
    const root = await createTempWorkspace();
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(root, "definitely.bin"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const result = await registry.getTool("grep").execute("1", { workdir: ".", pattern: "a", path: "definitely.bin" }, undefined, undefined, { cwd: root });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/binary file/);
  });

  it("returns isError for a binary file path even when the call is not aborted", async () => {
    const root = await createTempWorkspace();
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(root, "definitely.bin"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const start = Date.now();
    const result = await registry.getTool("grep").execute("1", { workdir: ".", pattern: "a", path: "definitely.bin", timeout_seconds: 5 }, undefined, undefined, { cwd: root });
    const elapsed = Date.now() - start;
    expect(result.isError).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });
});
