import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import piBaseExtension from "../index.js";
import { applyContextCompressionToMessages, shouldApplyContextCompression } from "../src/context-compression.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

let previousGlobalSettingsPath: string | undefined;

beforeEach(async () => {
  previousGlobalSettingsPath = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  const root = await createTempWorkspace();
  const globalPath = join(root, "global-pi-base.json");
  await writeFile(globalPath, JSON.stringify({}), "utf8");
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = globalPath;
});

afterEach(() => {
  if (previousGlobalSettingsPath === undefined) delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  else process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
});

const GENERIC_TOOL_OUTPUT_PLACEHOLDER = "[context compression: older tool output omitted. Re-run the tool if you need those details.]";
const BASH_OUTPUT_PLACEHOLDER = "[context compression: older tool output omitted. If you need those details, re-check the current state, or re-run the command only if it is safe to do so.]";

function userMessage(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantToolCallMessage(toolName: string, toolCallId: string, args: any) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function assistantTextMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toolResultMessage(toolName: string, toolCallId: string, result: any) {
  return {
    role: "toolResult",
    toolName,
    toolCallId,
    content: result.content,
    details: result.details,
    isError: result.isError === true,
  };
}

function toolExchange(toolName: string, toolCallId: string, args: any, result: any) {
  return [assistantToolCallMessage(toolName, toolCallId, args), toolResultMessage(toolName, toolCallId, result)];
}

describe("context compression", () => {
  it("does not introduce dedicated footer markers when contextCompression is configured", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true } }), "utf8");
    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { type: "session_start" }, { cwd: root });

    const footerLines = registry.renderFooter(120);
    expect(footerLines.length).toBeGreaterThanOrEqual(2);
    expect(footerLines.at(-1) ?? "").toContain("agent:default");
    expect(footerLines.join("\n")).not.toContain("contextCompression");
    expect(footerLines.join("\n")).not.toContain("anchorHygiene");
  });

  it("masks stale read outputs after later edits to the same file", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true } }), "utf8");
    await writeWorkspaceFile(root, "src/example.txt", "alpha\nbeta\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const readArgs = { workdir: ".", path: "src/example.txt" };
    const readResult = await registry.getTool("read").execute("read-1", readArgs, undefined, undefined, { cwd: root });
    const editArgs = { workdir: ".", path: "src/example.txt", old_string: "alpha", new_string: "alpha v1" };
    const editResult = await registry.getTool("edit").execute("edit-1", editArgs, undefined, undefined, { cwd: root });

    const messages = [
      ...toolExchange("read", "read-1", readArgs, readResult),
      ...toolExchange("edit", "edit-1", editArgs, editResult),
    ];
    const transformed = await registry.emit("context", { messages }, { cwd: root });

    expect(getText(transformed.messages[1])).toBe(GENERIC_TOOL_OUTPUT_PLACEHOLDER);
    expect(getText(transformed.messages[3])).toContain("alpha v1");
    expect((transformed.messages[0] as any).content[0].arguments).toEqual(readArgs);
    expect((transformed.messages[2] as any).content[0].arguments).toEqual(editArgs);
  });

  it("masks stale reads when workdir and path spellings differ for the same file", async () => {
    // Intent: a read addressed via `workdir` + relative path and a later edit addressed
    // via the equivalent path from the root resolve to the same file. anchorHygiene must
    // recognize them as one file, otherwise the stale read would survive. This regresses
    // the bug where path resolution ignored `workdir`.
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true } }), "utf8");
    await writeWorkspaceFile(root, "pkg/example.txt", "alpha\nbeta\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    // Same real file (<root>/pkg/example.txt) referenced two different ways.
    const readArgs = { workdir: "pkg", path: "example.txt" };
    const readResult = await registry.getTool("read").execute("read-1", readArgs, undefined, undefined, { cwd: root });
    const editArgs = { workdir: ".", path: "pkg/example.txt", old_string: "alpha", new_string: "alpha v1" };
    const editResult = await registry.getTool("edit").execute("edit-1", editArgs, undefined, undefined, { cwd: root });

    const messages = [
      ...toolExchange("read", "read-1", readArgs, readResult),
      ...toolExchange("edit", "edit-1", editArgs, editResult),
    ];
    const transformed = await registry.emit("context", { messages }, { cwd: root });

    expect(getText(transformed.messages[1])).toBe(GENERIC_TOOL_OUTPUT_PLACEHOLDER);
    expect(getText(transformed.messages[3])).toContain("alpha v1");

    // Re-running compression on an already-compressed prefix must be byte-stable
    // (idempotent), so prompt-prefix caches are not invalidated across turns.
    const again = await registry.emit("context", { messages: transformed.messages }, { cwd: root });
    const stable = again === undefined ? transformed.messages : again.messages;
    expect(stable).toEqual(transformed.messages);
  });

  it("masks separator aliases only after both calls reach the same real file", async () => {
    // Intent: context tracking already normalizes separators; execution must do
    // the same so a backslash-spelled read cannot refer to a different POSIX file.
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true } }), "utf8");
    await writeWorkspaceFile(root, "pkg/nested/example.txt", "alpha\nbeta\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);
    const readArgs = { workdir: "pkg\\nested", path: "example.txt" };
    const readResult = await registry.getTool("read").execute("read-separator", readArgs, undefined, undefined, { cwd: root });
    const patchArgs = {
      workdir: "pkg/nested",
      patchText: "*** Begin Patch\n*** Update File: .\\example.txt\n@@\n-alpha\n+alpha v1\n*** End Patch",
    };
    const patchResult = await registry.getTool("apply_patch").execute("patch-separator", patchArgs, undefined, undefined, { cwd: root });
    const messages = [
      ...toolExchange("read", "read-separator", readArgs, readResult),
      ...toolExchange("apply_patch", "patch-separator", patchArgs, patchResult),
    ];
    const transformed = await registry.emit("context", { messages }, { cwd: root });

    expect(readResult.isError).not.toBe(true);
    expect(patchResult.isError).not.toBe(true);
    expect(getText(transformed.messages[1])).toBe(GENERIC_TOOL_OUTPUT_PLACEHOLDER);
    expect(await readFile(join(root, "pkg", "nested", "example.txt"), "utf8")).toBe("alpha v1\nbeta\n");
  });

  it("keeps an already-folded prefix byte-stable as later turns append new tool calls", async () => {
    // Intent: prompt-prefix caching depends on the compressed prefix not shifting across
    // turns. anchorHygiene folds a read once its file is edited; appending later unrelated
    // turns must leave the earlier folded region byte-identical (verifies multi-turn append
    // stability of the workdir-aware path resolution).
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true } }), "utf8");
    await writeWorkspaceFile(root, "pkg/a.txt", "alpha\n");
    await writeWorkspaceFile(root, "pkg/b.txt", "one\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const readA = { workdir: "pkg", path: "a.txt" };
    const readAResult = await registry.getTool("read").execute("read-a", readA, undefined, undefined, { cwd: root });
    const editA = { workdir: ".", path: "pkg/a.txt", old_string: "alpha", new_string: "alpha v1" };
    const editAResult = await registry.getTool("edit").execute("edit-a", editA, undefined, undefined, { cwd: root });

    const turn1 = [
      ...toolExchange("read", "read-a", readA, readAResult),
      ...toolExchange("edit", "edit-a", editA, editAResult),
    ];
    const compressed1 = await registry.emit("context", { messages: turn1 }, { cwd: root });
    expect(getText(compressed1.messages[1])).toBe(GENERIC_TOOL_OUTPUT_PLACEHOLDER);

    // Append a later, unrelated turn on a different file, then recompress the full history.
    const readB = { workdir: "pkg", path: "b.txt" };
    const readBResult = await registry.getTool("read").execute("read-b", readB, undefined, undefined, { cwd: root });
    const editB = { workdir: ".", path: "pkg/b.txt", old_string: "one", new_string: "one v1" };
    const editBResult = await registry.getTool("edit").execute("edit-b", editB, undefined, undefined, { cwd: root });

    const turn2 = [
      ...turn1,
      ...toolExchange("read", "read-b", readB, readBResult),
      ...toolExchange("edit", "edit-b", editB, editBResult),
    ];
    const compressed2 = await registry.emit("context", { messages: turn2 }, { cwd: root });

    // The earlier (turn 1) portion of the recompressed history stays byte-identical.
    expect(compressed2.messages.slice(0, turn1.length)).toEqual(compressed1.messages);
  });

  it("does not mask write acknowledgements as part of anchorHygiene", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true } }), "utf8");
    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const writeArgs = { workdir: ".", path: "src/example.txt", content: "alpha\nbeta\n" };
    const writeResult = await registry.getTool("write").execute("write-1", writeArgs, undefined, undefined, { cwd: root });
    const editArgs = { workdir: ".", path: "src/example.txt", old_string: "alpha", new_string: "alpha v1" };
    const editResult = await registry.getTool("edit").execute("edit-after-write", editArgs, undefined, undefined, { cwd: root });

    const messages = [
      ...toolExchange("write", "write-1", writeArgs, writeResult),
      ...toolExchange("edit", "edit-after-write", editArgs, editResult),
    ];
    const transformed = await registry.emit("context", { messages }, { cwd: root });

    // anchorHygiene intentionally excludes `write`: the earlier write ack must stay visible
    // as a timeline anchor. The later edit is the most recent tool call, so there's no
    // subsequent mutation to dirty its path either. Net effect: nothing gets masked,
    // and the context hook returns undefined (no message rewrite happened).
    expect(transformed).toBeUndefined();
    expect(getText(messages[1])).toMatch(/^(Created|Overwrote) src\/example\.txt successfully\.$/);
    expect(getText(messages[3])).toContain("Edited src/example.txt successfully");
  });

  it("leaves failed edit error context visible after a later successful edit", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true } }), "utf8");
    await writeWorkspaceFile(root, "src/example.txt", "alpha\nbeta\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const failedEditArgs = { workdir: ".", path: "src/example.txt", old_string: "nonexistent", new_string: "replacement" };
    const failedEdit = await registry.getTool("edit").execute("edit-error-context", failedEditArgs, undefined, undefined, { cwd: root });
    expect(failedEdit.isError).toBe(true);
    expect(getText(failedEdit)).toContain("Could not find old_string");

    const goodEditArgs = { workdir: ".", path: "src/example.txt", old_string: "alpha", new_string: "alpha v1" };
    const goodEdit = await registry.getTool("edit").execute("edit-after-error-context", goodEditArgs, undefined, undefined, { cwd: root });

    const messages = [
      ...toolExchange("edit", "edit-error-context", failedEditArgs, failedEdit),
      ...toolExchange("edit", "edit-after-error-context", goodEditArgs, goodEdit),
    ];

    expect(await registry.emit("context", { messages }, { cwd: root })).toBeUndefined();
  });


  it("leaves stale file outputs in context by default", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.txt", "alpha\nbeta\n");
    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const readArgs = { workdir: ".", path: "src/example.txt" };
    const readResult = await registry.getTool("read").execute("read-default", readArgs, undefined, undefined, { cwd: root });
    await registry.getTool("edit").execute("edit-default", { workdir: ".", path: "src/example.txt", old_string: "alpha", new_string: "alpha v1" }, undefined, undefined, { cwd: root });

    const messages = [...toolExchange("read", "read-default", readArgs, readResult)];
    const transformed = await registry.emit("context", { messages }, { cwd: root });
    expect(transformed).toBeUndefined();
  });

  // Intent: provider gating first narrows the allowlist, then disabledProviders may still
  // veto a provider even if it was explicitly enabled.
  it("shouldApplyContextCompression honors enabledProviders first, then disabledProviders", () => {
    const disabledOnly = { tools: ["bash"], disabledProviders: ["xai"] };
    expect(shouldApplyContextCompression(disabledOnly, "xai")).toBe(false);
    expect(shouldApplyContextCompression(disabledOnly, "XAI")).toBe(false);
    expect(shouldApplyContextCompression(disabledOnly, "openai")).toBe(true);

    const enabledOnly = { tools: ["bash"], enabledProviders: ["openai", "google"] };
    expect(shouldApplyContextCompression(enabledOnly, "openai")).toBe(true);
    expect(shouldApplyContextCompression(enabledOnly, "OPENAI")).toBe(true);
    expect(shouldApplyContextCompression(enabledOnly, "xai")).toBe(false);

    const enabledEmpty = { tools: ["bash"], enabledProviders: [] };
    expect(shouldApplyContextCompression(enabledEmpty, "openai")).toBe(false);
    expect(shouldApplyContextCompression(enabledEmpty, "xai")).toBe(false);

    const enabledAndDisabled = { tools: ["bash"], enabledProviders: ["openai", "xai"], disabledProviders: ["xai"] };
    expect(shouldApplyContextCompression(enabledAndDisabled, "openai")).toBe(true);
    expect(shouldApplyContextCompression(enabledAndDisabled, "xai")).toBe(false);

    expect(shouldApplyContextCompression(undefined, "xai")).toBe(false);
  });

  // Intent: age-based masking must hide old tool output while keeping recent rounds for working context.
  it("masks older configured tool outputs after enough assistant turns", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(
      join(root, ".pi", "pi-base.json"),
      JSON.stringify({
        contextCompression: {
          tools: ["bash"],
          retainedUserMessageRounds: 1,
          retainedAssistantTurns: 1,
        },
      }),
      "utf8",
    );
    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const bashArgs = { workdir: ".", command: "echo hi" };
    const bashResult = {
      content: [{ type: "text" as const, text: "hi\n" }],
      details: undefined,
    };
    const messages = [
      userMessage("round-1"),
      ...toolExchange("bash", "bash-1", bashArgs, bashResult),
      assistantTextMessage("done-1"),
      userMessage("round-2"),
      assistantTextMessage("done-2"),
    ];
    const transformed = await registry.emit("context", { messages }, { cwd: root });
    expect(getText(transformed.messages[2])).toBe(BASH_OUTPUT_PLACEHOLDER);
  });

  // Intent: skill reads from <available_skills> must stay visible even when age compression would mask reads.
  it("does not mask skill read outputs when the path is listed in available_skills", async () => {
    const root = await createTempWorkspace();
    const skillFile = join(root, "skills", "demo-skill", "SKILL.md");
    await mkdir(dirname(skillFile), { recursive: true });
    await writeFile(skillFile, "# demo", "utf8");
    const readBody = `[skills/demo-skill/SKILL.md#A1B2]\n1:# demo`;
    const messages = [
      userMessage("load"),
      { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "skills/demo-skill/SKILL.md" } }] },
      { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: readBody }], isError: false },
      assistantTextMessage("ok"),
      userMessage("later"),
      assistantTextMessage("done"),
    ];
    const next = applyContextCompressionToMessages(messages, root, {
      tools: ["read"],
      retainedUserMessageRounds: 1,
      retainedAssistantTurns: 1,
    }, {
      systemPrompt: `<available_skills><skill><location>${skillFile}</location></skill></available_skills>`,
    });
    expect(getText(next[2])).toContain("# demo");
  });
});
