import { execFile, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createTempWorkspace } from "./helpers.js";

const execFileAsync = promisify(execFile);
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

describe("image-understanding CLI", () => {
  it.skipIf(process.platform === "win32" || !hasPython3)("keeps the MiniMax API key out of child-process arguments", async () => {
    // Intent: credentials are inherited through the environment; passing them as --api-key would
    // expose the secret to process listings and other local process inspectors.
    const root = await createTempWorkspace();
    const binDir = join(root, "bin");
    const capturePath = join(root, "capture.json");
    const fakeMmx = join(binDir, "mmx");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeMmx,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.PI_BASE_MMX_CAPTURE, JSON.stringify({
  argv: process.argv.slice(2),
  apiKey: process.env.MINIMAX_API_KEY,
}));
`,
      { mode: 0o755 },
    );
    const cli = resolve("skills/image-understanding/scripts/image-understanding-cli");
    const apiKey = "test-secret-not-for-argv";

    await execFileAsync("python3", [cli, "--prompt", "inspect", "--image", "@/tmp/image.png"], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        MINIMAX_API_KEY: apiKey,
        PI_BASE_MMX_CAPTURE: capturePath,
      },
    });

    const captured = JSON.parse(await readFile(capturePath, "utf8")) as { argv: string[]; apiKey?: string };
    expect(captured.apiKey).toBe(apiKey);
    expect(captured.argv).toEqual([
      "vision",
      "describe",
      "--image",
      "/tmp/image.png",
      "--prompt",
      "inspect",
      "--output",
      "json",
    ]);
    expect(captured.argv).not.toContain("--api-key");
    expect(captured.argv).not.toContain(apiKey);
  });
});
