import { describe, expect, it } from "vitest";
import { registerGrepTool } from "../src/grep.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

describe("grep multiline error paths", () => {
  it("returns no matches for multiline searches with no results", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.txt", "alpha\nbeta\n");
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any);

    const result = await registry.getTool("grep").execute(
      "1",
      { workdir: ".", pattern: "gamma\ndelta", path: "src", multiline: true },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(getText(result)).toBe("No matches found");
  });

  it("surfaces multiline ripgrep regex failures", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.txt", "alpha\nbeta\n");
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any);

    const result = await registry.getTool("grep").execute(
      "1",
      { workdir: ".", pattern: "(", path: "src", multiline: true },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("regex parse error");
  });
});
