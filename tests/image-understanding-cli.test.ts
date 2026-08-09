import { execFile, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
    const capturePath = join(root, "capture.json");
    const imagePath = join(root, "image.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const cli = resolve("skills/image-understanding/scripts/image-understanding-cli");
    const harnessPath = join(root, "harness.py");
    await writeFile(
      harnessPath,
      `import importlib.util
from importlib.machinery import SourceFileLoader
import json
import os
import sys

sys.dont_write_bytecode = True
cli_path = os.environ["PI_BASE_IMAGE_CLI"]
spec = importlib.util.spec_from_loader(
    "image_understanding_cli",
    SourceFileLoader("image_understanding_cli", cli_path),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

sys.argv = [cli_path, "--prompt", "inspect", "--image", os.environ["PI_BASE_IMAGE"]]

def fake_call_api(payload, api_key):
    with open(os.environ["PI_BASE_CAPTURE"], "w", encoding="utf-8") as output:
        json.dump({
            "argv": sys.argv[1:],
            "apiKey": api_key,
            "payload": payload,
        }, output)
    return {"content": [{"type": "text", "text": "ok"}]}

module.call_api = fake_call_api
raise SystemExit(module.main())
`,
    );
    const apiKey = "test-secret-not-for-argv";

    await execFileAsync("python3", [harnessPath], {
      env: {
        ...process.env,
        MINIMAX_API_KEY: apiKey,
        PI_BASE_IMAGE_CLI: cli,
        PI_BASE_IMAGE: imagePath,
        PI_BASE_CAPTURE: capturePath,
      },
    });

    const captured = JSON.parse(await readFile(capturePath, "utf8")) as {
      argv: string[];
      apiKey?: string;
      payload: {
        model: string;
        messages: Array<{
          role: string;
          content: Array<{
            type: string;
            text?: string;
            source?: { type: string; media_type: string; data: string };
          }>;
        }>;
      };
    };
    expect(captured.apiKey).toBe(apiKey);
    expect(captured.argv).toEqual(["--prompt", "inspect", "--image", imagePath]);
    expect(captured.argv).not.toContain("--api-key");
    expect(captured.argv).not.toContain(apiKey);
    expect(captured.payload.model).toBe("MiniMax-M3");
    expect(captured.payload.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "inspect" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: expect.any(String),
          },
        },
      ],
    }]);
    expect(captured.payload.messages[0]?.content[1]?.source?.data).not.toBe("");
  });
});
