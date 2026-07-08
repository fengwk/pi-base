import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { lspManager } from "../src/lsp/client.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

function render(component: any): string {
  return component.render(200).join("\n");
}

describe("index lifecycle behavior", () => {
  it("reloads runtime settings and shuts down lsp only on session reload", async () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    let shutdownCalls = 0;
    const original = lspManager.shutdownAll.bind(lspManager);
    lspManager.shutdownAll = async () => {
      shutdownCalls += 1;
    };

    try {
      await registry.emit("session_start", { reason: "startup" }, { cwd: process.cwd() });
      await registry.emit("session_shutdown", { reason: "quit" }, { cwd: process.cwd() });
      expect(shutdownCalls).toBe(0);

      await registry.emit("session_start", { reason: "reload" }, { cwd: process.cwd() });
      expect(shutdownCalls).toBe(1);
    } finally {
      lspManager.shutdownAll = original;
    }
  });

  it("renders the custom find call format and rejects missing paths", async () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const call = render(registry.getTool("find").renderCall(
      { pattern: "*.ts", path: "src", workdir: "packages/web", limit: 5, timeout_seconds: 10 },
      {} as any,
      { lastComponent: undefined },
    ));
    expect(call).toContain("find *.ts in src from packages/web [limit=5, timeout_seconds=10]");

    const result = await registry.getTool("find").execute("1", { pattern: "*.ts", workdir: "." }, undefined, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("find requires an explicit `path` argument");
  });

  it("uses the cached resolver factory for repeated reads in the same project", async () => {
    const root = await createTempWorkspace();
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const fakeLsp = join(binDir, "fake-lsp");
    await writeFile(fakeLsp, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(
      join(root, ".pi", "pi-base.json"),
      JSON.stringify({ lsp: { servers: { ts: { command: [fakeLsp], extensions: [".ts"] } } } }),
      "utf8",
    );
    await writeWorkspaceFile(root, "src/example.ts", "export const value = 1;\n");

    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const first = await registry.getTool("read").execute("1", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: root });
    const second = await registry.getTool("read").execute("2", { workdir: ".", path: "src/example.ts" }, undefined, undefined, { cwd: root });

    expect(getText(first)).toContain("lsp: supported (ts)");
    expect(getText(second)).toContain("lsp: supported (ts)");
  });
});
