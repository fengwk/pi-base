import { describe, expect, it } from "vitest";
import { registerGrepTool } from "../src/grep.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

function render(component: any): string {
  return component.render(200).join("\n");
}

describe("grep multiline extra coverage", () => {
  it("renders grep calls with all optional flags", () => {
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any);
    const rendered = render(registry.getTool("grep").renderCall(
      {
        pattern: "alpha\\nbeta",
        path: "src",
        workdir: "packages/web",
        include: "**/*.ts",
        ignoreCase: true,
        literal: true,
        multiline: true,
        limit: 5,
        timeout_seconds: 30,
      },
      {} as any,
      { lastComponent: undefined },
    ));

    expect(rendered).toContain('grep "alpha\\\\nbeta" in src from packages/web');
    expect(rendered).toContain("include=**/*.ts");
    expect(rendered).toContain("ignoreCase=true");
    expect(rendered).toContain("literal=true");
    expect(rendered).toContain("multiline=true");
    expect(rendered).toContain("timeout_seconds=30");
  });

  it("supports multiline grep with relative paths and limit notices", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.txt", "alpha\nbeta\nalpha\nbeta\n");
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any);

    const result = await registry.getTool("grep").execute(
      "1",
      { workdir: ".", pattern: "alpha\nbeta", path: "src", multiline: true, limit: 1 },
      undefined,
      undefined,
      { cwd: root },
    );

    const text = getText(result);
    expect(text).toContain("example.txt:1: alpha");
    expect(text).toContain("example.txt:2: beta");
    expect(text).toContain("matches limit reached");
  });

  it("truncates long multiline match lines and uses the basename for single-file searches", async () => {
    const root = await createTempWorkspace();
    const longLine = `prefix-${"a".repeat(600)}`;
    await writeWorkspaceFile(root, "src/long.txt", `${longLine}\nsecond\n`);
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any);

    const result = await registry.getTool("grep").execute(
      "1",
      { workdir: ".", pattern: `${longLine}\nsecond`, path: "src/long.txt", multiline: true, literal: true },
      undefined,
      undefined,
      { cwd: root },
    );

    const text = getText(result);
    expect(text).toContain("long.txt:1:");
    expect(text).not.toContain(`${"a".repeat(550)}`);
    expect(text).toContain("Some lines truncated");
  });

  it("rejects already-aborted multiline searches", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.txt", "alpha\nbeta\n");
    const registry = createToolRegistry();
    registerGrepTool(registry.pi as any);
    const controller = new AbortController();
    controller.abort();

    const result = await registry.getTool("grep").execute(
      "1",
      { workdir: ".", pattern: "alpha\nbeta", path: "src", multiline: true },
      controller.signal,
      undefined,
      { cwd: root },
    );

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Operation aborted");
  });
});
