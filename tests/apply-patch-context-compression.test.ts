import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyContextCompressionToMessages } from "../src/context-compression.js";
import { createTempWorkspace, getText } from "./helpers.js";

const FILE_PLACEHOLDER = "[context compression: older tool output omitted. If you need those details, re-check the current state or retrieve the relevant context again.]";
const GENERIC_PLACEHOLDER = "[context compression: older tool output omitted. Re-run the tool if you need those details.]";

function patch(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

function call(id: string, name: string, args: unknown) {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] };
}

function result(id: string, name: string, text: string, details?: unknown, isError = false) {
  return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], details, isError };
}

describe("apply_patch context compression", () => {
  it("treats multi-file success as both file context and mutation with workdir-relative paths", async () => {
    // Intent: one successful patch dirties every target for earlier reads, and its own
    // multi-file diff context becomes stale when any included file changes later.
    const root = await createTempWorkspace();
    const patchArgs = {
      workdir: "pkg",
      patchText: patch(
        "*** Add File: a.txt",
        "+a",
        "*** Add File: b.txt",
        "+b",
      ),
    };
    const messages = [
      call("read-a", "read", { workdir: "pkg", path: "a.txt" }),
      result("read-a", "read", "a context"),
      call("read-b", "read", { workdir: root, path: "pkg/b.txt" }),
      result("read-b", "read", "b context"),
      call("patch", "apply_patch", patchArgs),
      result("patch", "apply_patch", "Applied patch successfully"),
      call("edit-a", "edit", { workdir: root, path: "pkg/a.txt", old_string: "a", new_string: "A" }),
      result("edit-a", "edit", "Edited pkg/a.txt successfully"),
    ];

    const next = applyContextCompressionToMessages(messages, root, { anchorHygiene: true });
    expect(getText(next[1])).toBe(GENERIC_PLACEHOLDER);
    expect(getText(next[3])).toBe(GENERIC_PLACEHOLDER);
    expect(getText(next[5])).toBe(FILE_PLACEHOLDER);
    expect(getText(next[7])).toContain("Edited pkg/a.txt");
  });

  it("marks committed and unknown failed paths dirty without touching unexecuted targets", async () => {
    // Intent: a failed write may have changed its path, while a later unexecuted
    // target is known not to have been reached.
    const root = await createTempWorkspace();
    const first = join(root, "pkg", "first.txt");
    const messages = [
      call("read-first", "read", { workdir: "pkg", path: "first.txt" }),
      result("read-first", "read", "first context"),
      call("read-second", "read", { workdir: "pkg", path: "second.txt" }),
      result("read-second", "read", "second context"),
      call("read-third", "read", { workdir: "pkg", path: "third.txt" }),
      result("read-third", "read", "third context"),
      call("partial", "apply_patch", {
        workdir: "pkg",
        patchText: patch(
          "*** Add File: first.txt",
          "+first",
          "*** Add File: second.txt",
          "+second",
          "*** Add File: third.txt",
          "+third",
        ),
      }),
      result("partial", "apply_patch", "Error: Patch partially applied", {
        partial: true,
        failedPath: "second.txt",
        failedPathState: "unknown",
        files: [{ operation: "add", path: "first.txt", absolutePath: first, diff: "@@ -0,0 +1,1 @@\n+first", addedLines: 1, removedLines: 0 }],
      }, true),
    ];

    const next = applyContextCompressionToMessages(messages, root, { anchorHygiene: true });
    expect(getText(next[1])).toBe(GENERIC_PLACEHOLDER);
    expect(getText(next[3])).toBe(GENERIC_PLACEHOLDER);
    expect(getText(next[5])).toBe("third context");
    expect(getText(next[7])).toContain("Patch partially applied");
  });

  it("does not dirty targets for a non-committing preflight error", async () => {
    // Intent: only commit-stage uncertainty can invalidate a failed target.
    const root = await createTempWorkspace();
    const messages = [
      call("read", "read", { path: "missing.txt" }),
      result("read", "read", "current context"),
      call("patch", "apply_patch", { patchText: patch("*** Delete File: missing.txt") }),
      result("patch", "apply_patch", "Error: Patch preflight failed", { files: [], partial: false }, true),
    ];

    const next = applyContextCompressionToMessages(messages, root, { anchorHygiene: true });
    expect(getText(next[1])).toBe("current context");
    expect(getText(next[3])).toContain("Patch preflight failed");
  });
});
