import { describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { createTempWorkspace, createToolRegistry, getText } from "./helpers.js";

describe.skipIf(process.platform === "win32")("special filesystem nodes", () => {
  it("rejects non-regular nodes before read, grep, edit, or write performs file I/O", async () => {
    // Intent: /dev/null is a character device, not a text/image file. Every pi-base file tool
    // that owns local I/O must reject it instead of hanging, discarding writes, or misreporting
    // success. The same stat boundary covers FIFOs, sockets, and block devices.
    const root = await createTempWorkspace();
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);

    const results = await Promise.all([
      registry.getTool("read").execute("read-special", { path: "/dev/null" }, undefined, undefined, { cwd: root }),
      registry.getTool("grep").execute("grep-special", { path: "/dev/null", pattern: "x" }, undefined, undefined, { cwd: root }),
      registry.getTool("edit").execute(
        "edit-special",
        { path: "/dev/null", old_string: "x", new_string: "y" },
        undefined,
        undefined,
        { cwd: root },
      ),
      registry.getTool("write").execute(
        "write-special",
        { path: "/dev/null", content: "discarded" },
        undefined,
        undefined,
        { cwd: root },
      ),
    ]);

    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("not a regular file");
    }
  });
});
