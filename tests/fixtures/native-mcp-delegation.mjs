import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, VERSION,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getSystemMessageText } from "@earendil-works/pi-ai";

// Run outside Vitest's coverage process: only official loader/JITI executes pi-base here.
// No inline pi-base factory, loader-result edits, or module-marker impersonation.
const extensionPath = fileURLToPath(new URL("../../index.ts", import.meta.url));
const serverFixture = fileURLToPath(new URL("./native-mcp-server.mjs", import.meta.url));
const nativeTool = "mcp__fixture__echo";
const workerPrompt = "Worker: call the MCP echo tool with delegated-echo and report its result.";
let root;
let parent;
let cleanupPromise;

async function serverRecords() {
  try {
    return (await readFile(join(root, "server.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function declarations(context) {
  const tools = new Map();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

// At most 250 condition checks and 249 short delays; no unbounded readiness/exit loop.
async function poll(label, condition) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await condition()) return;
    if (attempt < 249) await delay(20);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function assertServersExited() {
  const starts = (await serverRecords()).filter((record) => record.type === "start");
  await poll("all MCP server processes to exit", () => starts.every(({ pid }) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  }));
}

function cleanup() {
  cleanupPromise ??= (async () => {
    try {
      const session = parent;
      parent = undefined;
      if (session) {
        try {
          await session.abort();
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          session.dispose();
        }
      }
      if (root) await assertServersExited();
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  })();
  return cleanupPromise;
}

// execFile's timeout sends SIGTERM. Give native sessions a chance to abort and close stdio
// transports before exiting; the wrapper also has its own finite timeout and diagnostics.
function interrupt() {
  console.error("Native MCP delegation interrupted; cleaning up sessions and temporary config.");
  void cleanup().then(
    () => process.exit(1),
    (error) => { console.error(error); process.exit(1); },
  );
}
process.once("SIGTERM", interrupt);
process.once("SIGINT", interrupt);

async function run() {
  assert.equal(VERSION, "1.0.0");
  root = await mkdtemp(join(tmpdir(), "pi-native-mcp-delegation-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(join(agentDir, "agents"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = join(agentDir, "pi-base.json");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    // The parent also uses additionalExtensionPaths. The SDK child must independently
    // discover this persistent path and pass the production module-instance check.
    extensions: [extensionPath], packages: [],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  await writeFile(join(agentDir, "pi-base.json"), JSON.stringify({
    defaultAgent: "parent", yolo: false,
    notify: { agentEnd: false, permissionAsked: false },
  }));
  await writeFile(join(agentDir, "agents", "parent.md"),
    `---\nname: parent\ntools: ["${nativeTool}"]\nsubagents: [worker]\n---\nParent delegation policy.\n`);
  // No model override: the actual factory must inherit the parent's local fake provider.
  await writeFile(join(agentDir, "agents", "worker.md"),
    `---\nname: worker\ntools: ["${nativeTool}"]\n---\nWorker delegation policy.\n`);
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
    autoEnableCodemode: false,
    mcpServers: { fixture: {
      command: process.execPath, args: [serverFixture, join(root, "server.jsonl")], exposure: "direct",
    } },
  }));

  const requests = [];
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: true, allowModelNetwork: false,
  });
  runtime.registerProvider("delegation-fixture", {
    api: "openai-completions", apiKey: "local-test-only", baseUrl: "http://invalid.local",
    models: [{
      id: "fake", name: "Fake", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      requests.push({ modelId: model.id, provider: model.provider, context: structuredClone(context) });
      const last = context.messages.filter((message) => message.role !== "system").at(-1);
      const text = last?.role === "user"
        ? typeof last.content === "string" ? last.content
          : last.content.filter((part) => part.type === "text").map((part) => part.text).join("")
        : "";
      let call;
      if (text === "Delegate to worker.") {
        call = { name: "task", arguments: { subagent_type: "worker", prompt: workerPrompt, max_turns: 5 } };
      } else if (text === workerPrompt) {
        call = { name: nativeTool, arguments: { text: "delegated-echo" } };
      } else if (text === "Check parent connection.") {
        call = { name: nativeTool, arguments: { text: "parent-still-alive" } };
      }
      const resultText = last?.role === "toolResult"
        ? last.content.filter((part) => part.type === "text").map((part) => part.text).join("")
        : "";
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: call ? [{ type: "toolCall", id: `delegation-call-${requests.length}`, ...call }]
          : [{ type: "text", text: last?.role === "toolResult" && last.toolName === nativeTool
            ? `Echo report: ${resultText}` : `Delegation report: ${resultText}` }],
        stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      return stream;
    },
  });
  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.setProjectTrusted(false);
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, additionalExtensionPaths: [extensionPath],
    noContextFiles: true, noSkills: true, noPromptTemplates: true,
    extensionFactories: [{ name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true }],
  });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const piBase = loaded.extensions.filter((extension) => extension.resolvedPath === extensionPath);
  assert.equal(piBase.length, 1);
  assert.equal(piBase[0].tools.has("task"), true);
  const result = await createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader, modelRuntime: runtime,
    model: runtime.getModel("delegation-fixture", "fake"), sessionManager: SessionManager.inMemory(cwd),
  });
  parent = result.session;
  const extensionErrors = [];
  parent.extensionRunner.onError((error) => extensionErrors.push(error));
  await parent.bindExtensions({});
  await parent.prompt("Delegate to worker.");

  // Completion is only accepted after the unmodified real factory's identity check, MCP
  // execution, report collection and automatic child disposal have all run.
  const taskResult = parent.messages.find((message) => message.role === "toolResult" && message.toolName === "task");
  assert.ok(taskResult, "parent must receive the actual task result");
  assert.equal(taskResult.isError, false);
  assert.equal(taskResult.details.result.state, "completed");
  assert.equal(taskResult.details.result.report, "Echo report: delegated-echo");
  const childId = taskResult.details.result.sessionId;
  assert.ok(childId);
  assert.notEqual(childId, parent.sessionId);
  const childRequest = requests.find(({ context }) => context.messages.some((message) =>
    message.role === "user" && JSON.stringify(message.content).includes(workerPrompt)));
  assert.ok(childRequest, "child must reach the inherited fake provider");
  assert.equal(childRequest.provider, "delegation-fixture");
  assert.equal(childRequest.modelId, "fake");
  const childTools = declarations(childRequest.context);
  assert.equal(childTools.length, 1);
  assert.equal(childTools[0].name, nativeTool);
  assert.match(childTools[0].description, /Echo fixture text/);
  assert.deepEqual(childTools[0].parameters.required, ["text"]);
  assert.deepEqual(childTools[0].parameters.properties, { text: { type: "string" } });
  assert.ok(childRequest.context.messages.some((message) =>
    message.role === "system" && getSystemMessageText(message).includes("Worker delegation policy.")));
  assert.ok(childRequest.context.messages.some((message) =>
    message.role === "system" && message.sections?.preamble === "Worker delegation policy."));

  const childFiles = await readdir(join(agentDir, "subagent-sessions"), { recursive: true });
  const childFile = childFiles.find((file) => file.endsWith(`${childId}.jsonl`));
  assert.ok(childFile, "real child session must be persisted");
  const persistedChild = SessionManager.open(join(agentDir, "subagent-sessions", childFile));
  assert.ok(persistedChild.getEntries().some((entry) =>
    entry.type === "custom" && entry.customType === "pi-base-agent-state" && entry.data.name === "worker"));
  const childToolResult = persistedChild.buildSessionContext().messages.find((message) =>
    message.role === "toolResult" && message.toolName === nativeTool);
  assert.ok(childToolResult);
  assert.equal(childToolResult.isError, false);
  assert.deepEqual(childToolResult.content, [{ type: "text", text: "delegated-echo" }]);

  const starts = (await serverRecords()).filter((record) => record.type === "start");
  assert.equal(starts.length, 2);
  const parentPid = starts[0].pid;
  const childPid = starts[1].pid;
  assert.notEqual(childPid, parentPid);
  assert.deepEqual((await serverRecords()).filter((record) => record.type === "call"), [
    { pid: childPid, type: "call", text: "delegated-echo" },
  ]);
  await poll("the task's child MCP process to exit", async () =>
    (await serverRecords()).some((record) => record.type === "exit" && record.pid === childPid));
  assert.equal((await serverRecords()).some((record) => record.type === "exit" && record.pid === parentPid), false);
  await parent.prompt("Check parent connection.");
  assert.deepEqual((await serverRecords()).filter((record) => record.type === "call"), [
    { pid: childPid, type: "call", text: "delegated-echo" },
    { pid: parentPid, type: "call", text: "parent-still-alive" },
  ]);
  assert.deepEqual(extensionErrors, []);
  await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  parent.dispose();
  parent = undefined;
  await assertServersExited();
  assert.deepEqual((await serverRecords()).filter((record) => record.type === "exit").map((record) => record.pid).sort(),
    [parentPid, childPid].sort());
}

// An internal deadline leaves time for cleanup before the wrapper's independent timeout.
const deadline = setTimeout(interrupt, 20_000);
try {
  await run();
} finally {
  clearTimeout(deadline);
  await cleanup();
  process.removeListener("SIGTERM", interrupt);
  process.removeListener("SIGINT", interrupt);
}
console.log(JSON.stringify({
  status: "passed", sdkVersion: VERSION, report: "Echo report: delegated-echo",
  childTool: nativeTool, independentConnections: 2, serversExited: 2,
}));
