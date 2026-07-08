import { afterEach, describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { askSubagentPermissionHost, clearSubagentPermissionHost } from "../src/subagent/permission-host.js";
import { createToolRegistry } from "./helpers.js";

afterEach(() => {
  clearSubagentPermissionHost();
});

describe("subagent permission relay", () => {
  it("uses the same Yes/No actions as the normal permission prompt", async () => {
    // Intent: root-mediated subagent asks should match the main permission UI
    // so users do not have to relearn button semantics.
    const prompts: Array<{ title: string; items: string[] }> = [];
    const registry = createToolRegistry({
      hasUI: true,
      cwd: "/tmp/root-project",
      ui: {
        select: async (title, items) => {
          prompts.push({ title, items });
          return "Yes";
        },
      },
    });
    piBaseExtension(registry.pi as any);

    await registry.emit("session_start", { reason: "startup" }, {
      cwd: "/tmp/root-project",
      hasUI: true,
      sessionManager: {
        getSessionId: () => "root-session",
        getEntries: () => [],
      },
    });

    const allowed = await askSubagentPermissionHost({
      agentType: "worker",
      depth: 2,
      rootSessionId: "root-session",
      prompt: "Permission request",
    });

    expect(allowed).toBe(true);
    expect(prompts).toEqual([
      {
        title: "⟳ subagent「worker」(depth 2) requests permission\n\nPermission request",
        items: ["Yes", "No"],
      },
    ]);
  });
});
