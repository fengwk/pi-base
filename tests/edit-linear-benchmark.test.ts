import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { createToolRegistry } from "./helpers.js";

async function replaceEveryLine(lineCount: number): Promise<{ elapsedMs: number; replacements: number; isError: boolean }> {
  const root = await mkdtemp(join(tmpdir(), "pi-base-edit-bench-"));
  try {
    const lines = Array.from({ length: lineCount }, (_, index) => `value-${String(index).padStart(6, "0")} NEEDLE tail`);
    await writeFile(join(root, "bench.txt"), `${lines.join("\n")}\n`, "utf8");
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as never);
    const startedAt = performance.now();
    const result = await registry.getTool("edit").execute(
      "bench",
      { workdir: ".", path: "bench.txt", edits: [{ old_string: "NEEDLE", new_string: "done", replace_all: true }] },
      undefined,
      undefined,
      { cwd: root },
    );
    return {
      elapsedMs: performance.now() - startedAt,
      replacements: result.details?.replacements ?? 0,
      isError: result.isError === true,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("edit replace_all performance", () => {
  it("stays linear for 20k and 80k replacements", async () => {
    // Intent: locating spans once and diffing only changed ranges keeps a
    // replace_all linear; the old implementation re-located from the file start
    // and diffed the whole file per replacement (20k took ~53s).
    const small = await replaceEveryLine(20_000);
    const large = await replaceEveryLine(80_000);

    expect(small.isError).toBe(false);
    expect(small.replacements).toBe(20_000);
    expect(large.isError).toBe(false);
    expect(large.replacements).toBe(80_000);
    expect(small.elapsedMs).toBeLessThan(1000);
    expect(large.elapsedMs).toBeLessThanOrEqual(5 * small.elapsedMs);
  }, 120_000);
});
