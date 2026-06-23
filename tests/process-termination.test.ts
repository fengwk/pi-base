import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createGracefulTerminator } from "../src/process-termination.js";

describe("createGracefulTerminator", () => {
  it("lets child processes handle SIGTERM before a force kill", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-base-term-"));
    const markerPath = join(root, "marker.txt");
    const command = `MARKER=${JSON.stringify(markerPath)}; trap 'printf term > "$MARKER"; exit 0' TERM; while true; do :; done`;
    const child = spawn("bash", ["-c", command], { stdio: "ignore" });
    const terminator = createGracefulTerminator(child, { forceKillAfterMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    terminator.terminate();
    await once(child, "close");
    terminator.cleanup();

    await expect(readFile(markerPath, "utf8")).resolves.toBe("term");
  });
});
