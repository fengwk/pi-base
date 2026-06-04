import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import piBaseExtension from "../index.js";
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
  if (previousGlobalSettingsPath === undefined) {
    delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  } else {
    process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
  }
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function anchorFor(text: string, lineContent: string): string {
  const match = text.match(new RegExp(`(?:^|\\n)(?:[+|]\\s*)?\\s*(\\d+:[0-9a-f]{3})\\|${escapeRegex(lineContent)}`));
  if (!match?.[1]) throw new Error(`No anchor found for ${JSON.stringify(lineContent)} in:\n${text}`);
  return match[1];
}

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

function availableSkillsPrompt(skillPath: string): string {
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "<available_skills>",
    "  <skill>",
    "    <name>demo-skill</name>",
    "    <description>Demo skill</description>",
    `    <location>${skillPath}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");
}

describe("context compression", () => {
  it("does not alter the footer when contextCompression is configured", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true } }), "utf8");
    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    await registry.emit("session_start", { type: "session_start" }, { cwd: root });

    expect(registry.renderFooter(120)).toEqual([]);
  });

  it("applies configured anchor hygiene statelessly", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true } }), "utf8");
    await writeWorkspaceFile(root, "src/example.txt", "alpha\nbeta\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);
    await registry.emit("session_start", { type: "session_start" }, { cwd: root });

    const readArgs = { path: "src/example.txt" };
    const readResult = await registry.getTool("read").execute("read-anchor-1", readArgs, undefined, undefined, { cwd: root });
    const alphaAnchor = anchorFor(getText(readResult), "alpha");
    const editArgs = { path: "src/example.txt", edits: [{ replace_lines: { start_anchor: alphaAnchor, end_anchor: alphaAnchor, new_text: "alpha v1" } }] };
    const editResult = await registry.getTool("edit").execute("edit-anchor-1", editArgs, undefined, undefined, { cwd: root });
    const messages = [
      ...toolExchange("read", "read-anchor-1", readArgs, readResult),
      ...toolExchange("edit", "edit-anchor-1", editArgs, editResult),
    ];

    const transformed = await registry.emit("context", { messages }, { cwd: root });
    expect(getText(transformed.messages[1])).toContain("earlier file output omitted because the file changed later");
  });

  it("masks stale read and edit outputs after later edits to the same file without modifying tool calls", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true } }), "utf8");
    await writeWorkspaceFile(root, "src/example.txt", "alpha\nbeta\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const readArgs = { path: "src/example.txt" };
    const readResult = await registry.getTool("read").execute("read-1", readArgs, undefined, undefined, { cwd: root });
    const alphaAnchor = anchorFor(getText(readResult), "alpha");

    const edit1Args = { path: "src/example.txt", edits: [{ replace_lines: { start_anchor: alphaAnchor, end_anchor: alphaAnchor, new_text: "alpha v1" } }] };
    const edit1 = await registry.getTool("edit").execute("edit-1", edit1Args, undefined, undefined, { cwd: root });
    const alphaV1Anchor = anchorFor(getText(edit1), "alpha v1");

    const edit2Args = { path: "src/example.txt", edits: [{ replace_lines: { start_anchor: alphaV1Anchor, end_anchor: alphaV1Anchor, new_text: "alpha v2" } }] };
    const edit2 = await registry.getTool("edit").execute("edit-2", edit2Args, undefined, undefined, { cwd: root });

    const messages = [
      ...toolExchange("read", "read-1", readArgs, readResult),
      ...toolExchange("edit", "edit-1", edit1Args, edit1),
      ...toolExchange("edit", "edit-2", edit2Args, edit2),
    ];
    const transformed = await registry.emit("context", { messages }, { cwd: root });

    expect(transformed?.messages).toHaveLength(6);
    expect(getText(transformed.messages[1])).toContain("earlier file output omitted because the file changed later");
    expect(getText(transformed.messages[1])).not.toContain("alpha");
    expect(getText(transformed.messages[3])).toContain("earlier file output omitted because the file changed later");
    expect(getText(transformed.messages[3])).not.toContain("alpha v1");
    expect(transformed.messages[3].details).toBe(edit1.details);
    expect(getText(transformed.messages[5])).toContain("alpha v2");
    expect((transformed.messages[0] as any).content[0].arguments).toEqual(readArgs);
    expect((transformed.messages[2] as any).content[0].arguments).toEqual(edit1Args);
  });

  it("masks stale write outputs after later edits", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true } }), "utf8");
    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const writeArgs = { path: "src/example.txt", content: "alpha\nbeta\n" };
    const writeResult = await registry.getTool("write").execute("write-1", writeArgs, undefined, undefined, { cwd: root });
    const alphaAnchor = anchorFor(getText(writeResult), "alpha");

    const editArgs = { path: "src/example.txt", edits: [{ replace_lines: { start_anchor: alphaAnchor, end_anchor: alphaAnchor, new_text: "alpha v1" } }] };
    const editResult = await registry.getTool("edit").execute("edit-after-write", editArgs, undefined, undefined, { cwd: root });

    const messages = [
      ...toolExchange("write", "write-1", writeArgs, writeResult),
      ...toolExchange("edit", "edit-after-write", editArgs, editResult),
    ];
    const transformed = await registry.emit("context", { messages }, { cwd: root });

    expect(getText(transformed.messages[1])).toContain("earlier file output omitted because the file changed later");
    expect(getText(transformed.messages[1])).not.toContain("alpha");
    expect(getText(transformed.messages[3])).toContain("alpha v1");
  });

  it("respects anchorHygiene=false without disabling configured age compression", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: false, tools: { bash: { retainedUserMessageRounds: 1, retainedAssistantTurns: 1 } } } }), "utf8");
    await writeWorkspaceFile(root, "src/example.txt", "alpha\nbeta\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const readArgs = { path: "src/example.txt" };
    const readResult = await registry.getTool("read").execute("read-anchor-hygiene-off", readArgs, undefined, undefined, { cwd: root });
    const alphaAnchor = anchorFor(getText(readResult), "alpha");
    const editArgs = { path: "src/example.txt", edits: [{ replace_lines: { start_anchor: alphaAnchor, end_anchor: alphaAnchor, new_text: "alpha v1" } }] };
    const editResult = await registry.getTool("edit").execute("edit-anchor-hygiene-off", editArgs, undefined, undefined, { cwd: root });
    const bashArgs = { command: "echo old", workdir: "." };
    const bashResult = { content: [{ type: "text", text: "old bash output" }] };

    const messages = [
      userMessage("round 1"),
      ...toolExchange("read", "read-anchor-hygiene-off", readArgs, readResult),
      ...toolExchange("bash", "bash-anchor-hygiene-off", bashArgs, bashResult),
      ...toolExchange("edit", "edit-anchor-hygiene-off", editArgs, editResult),
      userMessage("round 2"),
      assistantTextMessage("turn 2"),
    ];
    const transformed = await registry.emit("context", { messages }, { cwd: root });

    expect(getText(transformed.messages[2])).toContain("alpha");
    expect(getText(transformed.messages[4])).toContain("older tool output omitted");
  });

  it("does not path-stale grep directory results after later edits", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true } }), "utf8");
    await writeWorkspaceFile(root, "src/example.txt", "alpha\nbeta\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const grepArgs = { pattern: "alpha", path: "src", literal: true };
    const grepResult = await registry.getTool("grep").execute("grep-tree-1", grepArgs, undefined, undefined, { cwd: root });
    const alphaAnchor = anchorFor(getText(grepResult), "alpha");

    const editArgs = { path: "src/example.txt", edits: [{ replace_lines: { start_anchor: alphaAnchor, end_anchor: alphaAnchor, new_text: "alpha v1" } }] };
    const editResult = await registry.getTool("edit").execute("edit-after-grep-tree", editArgs, undefined, undefined, { cwd: root });

    const messages = [
      ...toolExchange("grep", "grep-tree-1", grepArgs, grepResult),
      ...toolExchange("edit", "edit-after-grep-tree", editArgs, editResult),
    ];
    const transformed = await registry.emit("context", { messages }, { cwd: root });

    expect(transformed).toBeUndefined();
  });

  it("masks stale edit error context after a later successful edit", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true } }), "utf8");
    await writeWorkspaceFile(root, "src/example.txt", "alpha\nbeta\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const readArgs = { path: "src/example.txt" };
    const readResult = await registry.getTool("read").execute("read-for-error-context", readArgs, undefined, undefined, { cwd: root });
    const alphaAnchor = anchorFor(getText(readResult), "alpha");
    const badAlphaAnchor = alphaAnchor.replace(/:[0-9a-f]{3}$/, (value) => value === ":fff" ? ":000" : ":fff");

    const failedEditArgs = { path: "src/example.txt", edits: [{ replace_lines: { start_anchor: badAlphaAnchor, end_anchor: badAlphaAnchor, new_text: "alpha bad" } }] };
    const failedEdit = await registry.getTool("edit").execute("edit-error-context", failedEditArgs, undefined, undefined, { cwd: root });
    expect(failedEdit.isError).toBe(true);
    expect(getText(failedEdit)).toContain("Current context");
    expect(getText(failedEdit)).toContain("alpha");

    const goodEditArgs = { path: "src/example.txt", edits: [{ replace_lines: { start_anchor: alphaAnchor, end_anchor: alphaAnchor, new_text: "alpha v1" } }] };
    const goodEdit = await registry.getTool("edit").execute("edit-after-error-context", goodEditArgs, undefined, undefined, { cwd: root });

    const messages = [
      ...toolExchange("edit", "edit-error-context", failedEditArgs, failedEdit),
      ...toolExchange("edit", "edit-after-error-context", goodEditArgs, goodEdit),
    ];
    const transformed = await registry.emit("context", { messages }, { cwd: root });

    expect(getText(transformed.messages[1])).toContain("earlier file output omitted because the file changed later");
    expect(getText(transformed.messages[1])).not.toContain("alpha");
    expect(getText(transformed.messages[3])).toContain("alpha v1");
  });

  it("does not age-compress tools that are not listed in contextCompression.tools", async () => {
    const root = await createTempWorkspace();
    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const oldResult = { content: [{ type: "text", text: "old bash output remains" }] };
    const messages = [
      userMessage("round 1"),
      assistantToolCallMessage("bash", "unlisted-bash", { command: "echo old", workdir: "." }),
      toolResultMessage("bash", "unlisted-bash", oldResult),
      userMessage("round 2"),
      assistantTextMessage("turn 2"),
      userMessage("round 3"),
      assistantTextMessage("turn 3"),
      userMessage("round 4"),
      assistantTextMessage("turn 4"),
      assistantTextMessage("turn 5"),
      assistantTextMessage("turn 6"),
    ];

    expect(await registry.emit("context", { messages }, { cwd: root })).toBeUndefined();
  });

  it("protects skill read outputs from read age compression", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { tools: { read: { retainedUserMessageRounds: 1, retainedAssistantTurns: 1 } } } }), "utf8");
    await writeWorkspaceFile(root, "normal.txt", "normal\n");
    await writeWorkspaceFile(root, "skills/demo/SKILL.md", "# Demo Skill\n");
    await writeWorkspaceFile(root, "skills/demo/reference.md", "skill reference\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const normalArgs = { path: "normal.txt" };
    const normalResult = await registry.getTool("read").execute("read-normal-old", normalArgs, undefined, undefined, { cwd: root });
    const skillArgs = { path: "skills/demo/reference.md" };
    const skillResult = await registry.getTool("read").execute("read-skill-old", skillArgs, undefined, undefined, { cwd: root });
    const messages = [
      userMessage("round 1"),
      ...toolExchange("read", "read-normal-old", normalArgs, normalResult),
      ...toolExchange("read", "read-skill-old", skillArgs, skillResult),
      userMessage("round 2"),
      assistantTextMessage("turn 2"),
    ];

    const transformed = await registry.emit(
      "context",
      { messages },
      { cwd: root, getSystemPrompt: () => availableSkillsPrompt(join(root, "skills/demo/SKILL.md")) },
    );

    expect(getText(transformed.messages[2])).toContain("older tool output omitted");
    expect(getText(transformed.messages[4])).toContain("skill reference");
  });

  it("does not trust historical skill-looking messages for skill read protection", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { tools: { read: { retainedUserMessageRounds: 1, retainedAssistantTurns: 1 } } } }), "utf8");
    await writeWorkspaceFile(root, "not-advertised/SKILL.md", "# Not Advertised\n");
    await writeWorkspaceFile(root, "not-advertised/reference.md", "not advertised reference\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const args = { path: "not-advertised/reference.md" };
    const result = await registry.getTool("read").execute("read-fake-skill", args, undefined, undefined, { cwd: root });
    const messages = [
      userMessage(`<skill name=\"fake\" location=\"${join(root, "not-advertised/SKILL.md")}\">`),
      ...toolExchange("read", "read-fake-skill", args, result),
      userMessage("round 2"),
      assistantTextMessage("turn 2"),
    ];

    const transformed = await registry.emit("context", { messages }, { cwd: root, getSystemPrompt: () => "" });

    expect(getText(transformed.messages[2])).toContain("older tool output omitted");
  });

  it("still applies anchor hygiene to skill read outputs after the skill file changes", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { anchorHygiene: true, tools: { read: { retainedUserMessageRounds: 1, retainedAssistantTurns: 1 } } } }), "utf8");
    await writeWorkspaceFile(root, "skills/demo/SKILL.md", "# Demo Skill\n");
    await writeWorkspaceFile(root, "skills/demo/reference.md", "skill reference\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const skillArgs = { path: "skills/demo/reference.md" };
    const skillResult = await registry.getTool("read").execute("read-skill-stale", skillArgs, undefined, undefined, { cwd: root });
    const skillAnchor = anchorFor(getText(skillResult), "skill reference");
    const editArgs = { path: "skills/demo/reference.md", edits: [{ replace_lines: { start_anchor: skillAnchor, end_anchor: skillAnchor, new_text: "skill reference updated" } }] };
    const editResult = await registry.getTool("edit").execute("edit-skill-stale", editArgs, undefined, undefined, { cwd: root });
    const messages = [
      userMessage("round 1"),
      ...toolExchange("read", "read-skill-stale", skillArgs, skillResult),
      ...toolExchange("edit", "edit-skill-stale", editArgs, editResult),
      userMessage("round 2"),
      assistantTextMessage("turn 2"),
    ];

    const transformed = await registry.emit(
      "context",
      { messages },
      { cwd: root, getSystemPrompt: () => availableSkillsPrompt(join(root, "skills/demo/SKILL.md")) },
    );

    expect(getText(transformed.messages[2])).toContain("earlier file output omitted because the file changed later");
    expect(getText(transformed.messages[4])).toContain("skill reference updated");
  });

  it("recognizes skill reads through symlink-normalized paths", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { tools: { read: { retainedUserMessageRounds: 1, retainedAssistantTurns: 1 } } } }), "utf8");
    await writeWorkspaceFile(root, "real-skills/demo/SKILL.md", "# Demo Skill\n");
    await writeWorkspaceFile(root, "real-skills/demo/reference.md", "skill reference via link\n");
    try {
      await symlink(join(root, "real-skills"), join(root, "linked-skills"), "dir");
    } catch {
      return;
    }

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const skillArgs = { path: "real-skills/demo/reference.md" };
    const skillResult = await registry.getTool("read").execute("read-skill-link", skillArgs, undefined, undefined, { cwd: root });
    const messages = [
      userMessage("round 1"),
      ...toolExchange("read", "read-skill-link", skillArgs, skillResult),
      userMessage("round 2"),
      assistantTextMessage("turn 2"),
    ];

    const transformed = await registry.emit(
      "context",
      { messages },
      { cwd: root, getSystemPrompt: () => availableSkillsPrompt(join(root, "linked-skills/demo/SKILL.md")) },
    );

    expect(transformed).toBeUndefined();
  });
  it("compresses configured older tool results only when both user-message rounds and assistant turns exceed retention", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { tools: { bash: {} } } }), "utf8");
    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const oldResult = { content: [{ type: "text", text: "old bash output" }] };
    const messages = [
      userMessage("round 1"),
      assistantToolCallMessage("bash", "old-bash", { command: "echo old", workdir: "." }),
      toolResultMessage("bash", "old-bash", oldResult),
      userMessage("round 2"),
      assistantTextMessage("turn 2"),
      userMessage("round 3"),
      assistantTextMessage("turn 3"),
      userMessage("round 4"),
      assistantTextMessage("turn 4"),
      assistantTextMessage("turn 5"),
      assistantTextMessage("turn 6"),
    ];

    const transformed = await registry.emit("context", { messages }, { cwd: root });
    expect(getText(transformed.messages[2])).toBe("[pi-base context compression: older tool output omitted. Re-run the tool if you need those details.]");
  });

  it("does not age-compress when only one retention dimension is exceeded", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { tools: { bash: {} } } }), "utf8");
    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const oldResult = { content: [{ type: "text", text: "old output remains" }] };
    const userOnlyMessages = [
      userMessage("round 1"),
      assistantToolCallMessage("bash", "user-only-bash", { command: "echo old", workdir: "." }),
      toolResultMessage("bash", "user-only-bash", oldResult),
      userMessage("round 2"),
      userMessage("round 3"),
      userMessage("round 4"),
    ];
    const turnOnlyMessages = [
      userMessage("round 1"),
      assistantToolCallMessage("bash", "turn-only-bash", { command: "echo old", workdir: "." }),
      toolResultMessage("bash", "turn-only-bash", oldResult),
      assistantTextMessage("turn 2"),
      assistantTextMessage("turn 3"),
      assistantTextMessage("turn 4"),
      assistantTextMessage("turn 5"),
      assistantTextMessage("turn 6"),
    ];

    expect(await registry.emit("context", { messages: userOnlyMessages }, { cwd: root })).toBeUndefined();
    expect(await registry.emit("context", { messages: turnOnlyMessages }, { cwd: root })).toBeUndefined();
  });

  it("treats consecutive user messages as one user-message round", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { tools: { bash: { retainedUserMessageRounds: 3, retainedAssistantTurns: 1 } } } }), "utf8");
    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const oldResult = { content: [{ type: "text", text: "old output should remain" }] };
    const messages = [
      userMessage("round 1a"),
      userMessage("round 1b"),
      assistantToolCallMessage("bash", "old-bash", { command: "echo old", workdir: "." }),
      toolResultMessage("bash", "old-bash", oldResult),
      userMessage("round 2"),
      assistantTextMessage("turn 2"),
      userMessage("round 3"),
      assistantTextMessage("turn 3"),
    ];

    const transformed = await registry.emit("context", { messages }, { cwd: root });
    expect(transformed).toBeUndefined();
  });

  it("honors configured per-tool context compression thresholds", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { tools: { bash: { retainedUserMessageRounds: 1, retainedAssistantTurns: 1 } } } }), "utf8");
    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const oldResult = { content: [{ type: "text", text: "old output" }] };
    const messages = [
      userMessage("round 1"),
      assistantToolCallMessage("bash", "old-bash", { command: "echo old", workdir: "." }),
      toolResultMessage("bash", "old-bash", oldResult),
      userMessage("round 2"),
      assistantTextMessage("turn 2"),
    ];

    const transformed = await registry.emit("context", { messages }, { cwd: root });
    expect(getText(transformed.messages[2])).toContain("older tool output omitted");
  });

  it("honors enable=false and supports arbitrary configured tool names", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify({ contextCompression: { tools: { bash: { enable: false }, custom_tool: { retainedUserMessageRounds: 1, retainedAssistantTurns: 1 } } } }), "utf8");
    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const bashResult = { content: [{ type: "text", text: "old bash output remains" }] };
    const customResult = { content: [{ type: "text", text: "old custom output" }] };
    const messages = [
      userMessage("round 1"),
      assistantToolCallMessage("bash", "disabled-bash", { command: "echo old", workdir: "." }),
      toolResultMessage("bash", "disabled-bash", bashResult),
      assistantToolCallMessage("custom_tool", "custom-1", { anything: true }),
      toolResultMessage("custom_tool", "custom-1", customResult),
      userMessage("round 2"),
      assistantTextMessage("turn 2"),
    ];

    const transformed = await registry.emit("context", { messages }, { cwd: root });
    expect(getText(transformed.messages[2])).toBe("old bash output remains");
    expect(getText(transformed.messages[4])).toContain("older tool output omitted");
  });

  it("leaves stale file outputs in context by default", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "src/example.txt", "alpha\nbeta\n");

    const registry = createToolRegistry({ cwd: root });
    piBaseExtension(registry.pi as any);

    const readArgs = { path: "src/example.txt" };
    const readResult = await registry.getTool("read").execute("read-default", readArgs, undefined, undefined, { cwd: root });
    const alphaAnchor = anchorFor(getText(readResult), "alpha");
    const editArgs = { path: "src/example.txt", edits: [{ replace_lines: { start_anchor: alphaAnchor, end_anchor: alphaAnchor, new_text: "alpha v1" } }] };
    await registry.getTool("edit").execute("edit-default", editArgs, undefined, undefined, { cwd: root });

    const messages = [
      ...toolExchange("read", "read-default", readArgs, readResult),
    ];
    const transformed = await registry.emit("context", { messages }, { cwd: root });
    expect(transformed).toBeUndefined();
  });
});
