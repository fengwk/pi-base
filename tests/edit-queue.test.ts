import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolRegistry, getText } from "./helpers.js";

afterEach(() => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("edit queue", () => {
  // Intent: one-entry and two-entry `edits` arrays must share the same queue path.
  it.each([
    { entryCount: 1, stale: true },
    { entryCount: 2, stale: true },
    { entryCount: 1, stale: false },
    { entryCount: 2, stale: false },
  ])("serializes same-file edits (edits=$entryCount, stale=$stale)", async ({ entryCount, stale }) => {
    // Intent: block the first write after its read. If the second edit can still
    // read old bytes, the final file is clobbered. Keeping the whole cycle inside
    // the queue makes the second edit observe the first write instead.
    let fileBytes = Buffer.from("alpha\ntail\nstable\n", "utf8");
    let releaseFirstWrite = () => {};
    let resolveFirstWriteStarted = () => {};
    const firstWriteStarted = new Promise<void>((resolve) => {
      resolveFirstWriteStarted = resolve;
    });
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writeCount = 0;

    vi.doMock("node:fs/promises", () => ({
      stat: vi.fn(async () => ({ isFile: () => true })),
      readFile: vi.fn(async () => Buffer.from(fileBytes)),
      writeFile: vi.fn(async (_path: string, data: Buffer | string) => {
        if (writeCount++ === 0) {
          resolveFirstWriteStarted();
          await firstWriteReleased;
        }
        fileBytes = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, "utf8");
      }),
    }));

    const { registerEditTool } = await import("../src/edit.js");
    const registry = createToolRegistry();
    registerEditTool(registry.pi as any);

    const firstEdit = registry.getTool("edit").execute(
      "1",
      {
        path: "src/example.ts",
        edits: entryCount === 2
          ? [{ old_string: "alpha", new_string: "gamma" }, { old_string: "tail", new_string: "end" }]
          : [{ old_string: "alpha", new_string: "gamma" }],
      },
      undefined,
      undefined,
      { cwd: "/tmp/pi-base-edit-queue" },
    );
    const secondEdit = registry.getTool("edit").execute(
      "2",
      { workdir: ".", path: "src/example.ts", edits: [stale
        ? { old_string: "alpha", new_string: "beta" }
        : { old_string: "stable", new_string: "final" }] },
      undefined,
      undefined,
      { cwd: "/tmp/pi-base-edit-queue" },
    );

    await firstWriteStarted;
    await Promise.resolve();
    releaseFirstWrite();

    const [firstResult, secondResult] = await Promise.all([firstEdit, secondEdit]);
    expect(firstResult.isError).not.toBe(true);
    if (stale) {
      expect(secondResult.isError).toBe(true);
      expect(getText(secondResult)).toContain("Could not find old_string");
    } else {
      expect(secondResult.isError).not.toBe(true);
    }
    expect(fileBytes.toString("utf8")).toBe(`gamma\n${entryCount === 2 ? "end" : "tail"}\n${stale ? "stable" : "final"}\n`);
    expect(writeCount).toBe(stale ? 1 : 2);
  });
});
