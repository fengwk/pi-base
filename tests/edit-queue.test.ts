import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolRegistry, getText } from "./helpers.js";

afterEach(() => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("edit queue", () => {
  it("serializes same-file concurrent edits through one read-modify-write critical section", async () => {
    // Intent: block the first write after its read. If the second edit can still
    // read old bytes, the final file is clobbered. Keeping the whole cycle inside
    // the queue makes the second edit observe the first write instead.
    let fileBytes = Buffer.from("alpha\n", "utf8");
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
      { workdir: ".", path: "src/example.ts", old_string: "alpha", new_string: "gamma" },
      undefined,
      undefined,
      { cwd: "/tmp/pi-base-edit-queue" },
    );
    const secondEdit = registry.getTool("edit").execute(
      "2",
      { workdir: ".", path: "src/example.ts", old_string: "alpha", new_string: "beta" },
      undefined,
      undefined,
      { cwd: "/tmp/pi-base-edit-queue" },
    );

    await firstWriteStarted;
    await Promise.resolve();
    releaseFirstWrite();

    const [firstResult, secondResult] = await Promise.all([firstEdit, secondEdit]);
    expect(firstResult.isError).not.toBe(true);
    expect(secondResult.isError).toBe(true);
    expect(getText(secondResult)).toContain("Could not find old_string");
    expect(fileBytes.toString("utf8")).toBe("gamma\n");
  });
});
