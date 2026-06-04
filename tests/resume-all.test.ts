import { mkdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SessionManager, SessionSelectorComponent } from "@earendil-works/pi-coding-agent";
import piBaseExtension from "../index.js";
import { createTempWorkspace, createToolRegistry } from "./helpers.js";

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T> | T): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await createTempWorkspace();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await run(agentDir);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
}

async function waitFor(check: () => boolean, timeoutMs: number = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for session selector state");
}

function appendConversation(session: SessionManager, name: string, userText: string): string {
  session.appendMessage({
    role: "user",
    content: [{ type: "text", text: userText }],
  } as any);
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `reply to ${userText}` }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  } as any);
  session.appendSessionInfo(name);
  return session.getSessionFile()!;
}

describe("resume-all command", () => {
  it("uses the built-in session selector UI in TUI mode and switches to the selected session", async () => {
    await withTempAgentDir(async () => {
      const rootA = await createTempWorkspace();
      const rootB = await createTempWorkspace();
      await mkdir(rootA, { recursive: true });
      await mkdir(rootB, { recursive: true });

      appendConversation(SessionManager.create(rootA), "Current project", "work on alpha");
      const sessionB = appendConversation(SessionManager.create(rootB), "Other project", "work on beta");

      let selectCalled = false;
      let renderedLines: string[] = [];
      const switched: string[] = [];
      const registry = createToolRegistry({ hasUI: true, cwd: rootA });
      registry.setUI({
        select: async () => {
          selectCalled = true;
          return undefined;
        },
        custom: async (factory) =>
          new Promise(async (finish) => {
            const component = await factory(
              { requestRender() {} },
              {},
              { matches: () => false },
              finish,
            );
            expect(component).toBeInstanceOf(SessionSelectorComponent);

            const selector = component as SessionSelectorComponent;
            const selectorState = selector as unknown as { scope?: string; sortMode?: string };
            await waitFor(() => {
              renderedLines = selector.render(160);
              return (
                selectorState.scope === "all" &&
                selectorState.sortMode === "recent" &&
                renderedLines.some((line) => line.includes("Resume Session (All)")) &&
                renderedLines.some((line) => line.includes("Other project"))
              );
            });

            expect(renderedLines.length).toBeLessThanOrEqual(20);
            expect(renderedLines.some((line) => line.includes("Current project"))).toBe(true);
            expect(renderedLines.some((line) => line.includes("Other project"))).toBe(true);
            expect(selectorState.scope).toBe("all");
            expect(selectorState.sortMode).toBe("recent");

            selector.getSessionList().onSelect?.(sessionB);
          }),
      });

      piBaseExtension(registry.pi as any);
      await registry.runCommand("resume-all", "", {
        cwd: rootA,
        mode: "tui",
        switchSession: async (sessionPath: string, options?: { withSession?: (ctx: any) => Promise<void> }) => {
          switched.push(sessionPath);
          if (options?.withSession) {
            await options.withSession({
              ui: {
                notify() {},
              },
            });
          }
          return { cancelled: false };
        },
      });

      expect(selectCalled).toBe(false);
      expect(switched).toEqual([sessionB]);
    });
  });

  it("requires bare /resume-all without arguments", async () => {
    const registry = createToolRegistry({ hasUI: true });
    piBaseExtension(registry.pi as any);

    await registry.runCommand("resume-all", "extra", {});

    expect(registry.getNotifications()).toContainEqual({ message: "Usage: /resume-all", variant: "warning" });
  });
});
