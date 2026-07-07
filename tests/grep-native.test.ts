import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeGrep } from "../src/grep-core.js";
import { createTempWorkspace, getText } from "./helpers.js";

const fakeToolState = vi.hoisted(() => ({ rgPath: "" }));

vi.mock("../src/internal/pi-coding-agent-utils.js", () => ({
  ensureTool: vi.fn(async (tool: string) => {
    if (tool !== "rg" || !fakeToolState.rgPath) return undefined;
    return fakeToolState.rgPath;
  }),
}));

afterEach(() => {
  fakeToolState.rgPath = "";
  delete process.env.PI_BASE_FAKE_RG_MODE;
  delete process.env.PI_BASE_FAKE_RG_FILE;
  delete process.env.PI_BASE_FAKE_RG_TEXT;
  delete process.env.PI_BASE_FAKE_RG_COUNT;
});

async function installFakeRg(root: string): Promise<string> {
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const rgPath = join(binDir, "rg");
  await writeFile(
    rgPath,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("ripgrep 99.0.0");
  process.exit(0);
}
const mode = process.env.PI_BASE_FAKE_RG_MODE || "match";
if (mode === "wait") {
  setInterval(() => {}, 1000);
} else if (mode === "error") {
  console.error("synthetic rg failure");
  process.exit(2);
} else if (mode === "no-match") {
  process.exit(1);
} else {
  if (mode === "invalid-json") console.log("{not-json");
  const file = process.env.PI_BASE_FAKE_RG_FILE;
  const lineText = process.env.PI_BASE_FAKE_RG_TEXT || "beta\\n";
  const count = Number(process.env.PI_BASE_FAKE_RG_COUNT || "1");
  for (let i = 0; i < count; i++) {
    console.log(JSON.stringify({
      type: "match",
      data: {
        path: { text: file },
        line_number: i + 2,
        lines: { text: lineText },
      },
    }));
  }
}
`,
    { mode: 0o755 },
  );
  fakeToolState.rgPath = rgPath;
  return rgPath;
}

describe("executeGrep native ripgrep path", () => {
  it("formats standard ripgrep matches with context and relative paths", async () => {
    // Intent: without the upstream built-in grep wrapper, pi-base owns parsing
    // rg JSON and context formatting; this verifies that user-visible output.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "src", "example.ts");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
    process.env.PI_BASE_FAKE_RG_MODE = "invalid-json";
    process.env.PI_BASE_FAKE_RG_FILE = filePath;

    const result = await executeGrep("grep-1", {
      workdir: ".",
      path: "src",
      pattern: "beta",
      context: 1,
    }, undefined, undefined, { cwd: root });

    const text = getText(result);
    expect(text).toContain("example.ts-1- alpha");
    expect(text).toContain("example.ts:2: beta");
    expect(text).toContain("example.ts-3- gamma");
    expect(result.isError).not.toBe(true);
  });

  it("reports match limits and long-line truncation from ripgrep output", async () => {
    // Intent: grep results are often large; the limit/truncation metadata is
    // what prevents the model from assuming the result set is complete.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "example.txt");
    await writeFile(filePath, `${"x".repeat(800)}\n`, "utf8");
    process.env.PI_BASE_FAKE_RG_MODE = "match";
    process.env.PI_BASE_FAKE_RG_FILE = filePath;
    process.env.PI_BASE_FAKE_RG_TEXT = `${"x".repeat(800)}\n`;
    process.env.PI_BASE_FAKE_RG_COUNT = "3";

    const result = await executeGrep("grep-2", {
      workdir: ".",
      path: "example.txt",
      pattern: "x",
      limit: 1,
    }, undefined, undefined, { cwd: root });

    expect(getText(result)).toContain("1 matches limit reached");
    expect(getText(result)).toContain("Some lines truncated to 500 chars");
    expect((result as any).details.matchLimitReached).toBe(1);
    expect((result as any).details.linesTruncated).toBe(true);
  });

  it("returns no-match and ripgrep failure results distinctly", async () => {
    // Intent: rg exit code 1 means no matches, while other non-zero exits must
    // remain actionable errors for the agent.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "example.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    process.env.PI_BASE_FAKE_RG_FILE = filePath;

    process.env.PI_BASE_FAKE_RG_MODE = "no-match";
    const noMatch = await executeGrep("grep-3", { workdir: ".", path: "example.txt", pattern: "missing" }, undefined, undefined, { cwd: root });
    expect(getText(noMatch)).toBe("No matches found");
    expect(noMatch.isError).not.toBe(true);

    process.env.PI_BASE_FAKE_RG_MODE = "error";
    const failed = await executeGrep("grep-4", { workdir: ".", path: "example.txt", pattern: "alpha" }, undefined, undefined, { cwd: root });
    expect(failed.isError).toBe(true);
    expect(getText(failed)).toContain("synthetic rg failure");
  });

  it("reports a timeout when ripgrep does not finish before timeout_seconds", async () => {
    // Intent: timeout handling is part of the contract for broad searches and
    // must convert a cancelled child process into a clear tool error.
    const root = await createTempWorkspace();
    await installFakeRg(root);
    const filePath = join(root, "example.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    process.env.PI_BASE_FAKE_RG_MODE = "wait";
    process.env.PI_BASE_FAKE_RG_FILE = filePath;

    const result = await executeGrep("grep-5", {
      workdir: ".",
      path: "example.txt",
      pattern: "alpha",
      timeout_seconds: 0.05,
    }, undefined, undefined, { cwd: root });

    expect(result.isError).toBe(true);
    expect(getText(result)).toBe("Error: Search timed out after 0.05s.");
  });
});
