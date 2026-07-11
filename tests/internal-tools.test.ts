import { describe, expect, it, vi } from "vitest";
import { createTempWorkspace } from "./helpers.js";

describe("managed fd/rg installation", () => {
  it("shares one in-flight installation and clears it after failure", async () => {
    // Intent: parallel first-use tool calls must not download/extract the same binary twice, while
    // a failed attempt must still allow a later retry.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousPath = process.env.PATH;
    process.env.PI_CODING_AGENT_DIR = await createTempWorkspace();
    process.env.PATH = "";
    vi.resetModules();

    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await fetchGate;
      return new Response("failed", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { ensureTool } = await import("../src/internal/pi-coding-agent-utils.js");
      const first = ensureTool("rg", true);
      const second = ensureTool("rg", true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      releaseFetch();
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      await expect(ensureTool("rg", true)).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
