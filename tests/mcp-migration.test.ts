import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const fault = vi.hoisted(() => ({ failCommit: false, commits: 0, failWrite: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (typeof args[0] === "number" && fault.failWrite > 0 && --fault.failWrite === 0) {
        actual.writeFileSync(args[0], "partial");
        throw new Error("Injected partial write");
      }
      return actual.writeFileSync(...args);
    },
    renameSync: (from: string, to: string) => {
      if (from.endsWith(".tmp") && fault.failCommit && ++fault.commits === 2) {
        throw new Error("Injected commit failure");
      }
      return actual.renameSync(from, to);
    },
  };
});
// The standalone Node-builtins CLI intentionally has no TypeScript dependency/declarations.
// @ts-expect-error JS migration script is outside the TypeScript source build.
import { convertConfig, validateToolMap, renameConfigReferences, renameMarkdown, planMigration, applyMigration } from "../scripts/migrate-mcp.mjs";

const script = fileURLToPath(new URL("../scripts/migrate-mcp.mjs", import.meta.url));
const roots: string[] = [];
const aliasMap = { old_read: "mcp__files__read" };
const legacy = () => ({
  permission: { old_read: "deny", read: "allow" },
  render: { collapsedToolResultLines: { old_read: 4 }, collapsedToolResultMaxChars: { old_read: 80 } },
  notify: { sound: "unchanged" },
  mcp: {
    callTimeoutMs: 1501,
    startupTimeoutMs: 12000,
    servers: {
      files: {
        type: "local", command: ["runner", "--arg", "${UNCHANGED}"],
        env: { KEY: "$SECRET", EMPTY: "", LITERAL: "Bearer ${TOKEN}" },
        cwd: "${ROOT}/path", toolPrefix: "", startupTimeoutMs: 3000,
      },
      web: {
        type: "remote", transport: "streamable-http", url: "https://example.test/mcp",
        headers: { Authorization: "literal-secret", Other: "$TOKEN" },
        callTimeoutMs: 3000, enabled: false,
      },
    },
  },
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-mcp-migration-test-"));
  roots.push(root);
  const configPath = join(root, "pi-base.json");
  const toolMapPath = join(root, "map.json");
  writeFileSync(configPath, JSON.stringify(legacy()), { mode: 0o640 });
  writeFileSync(toolMapPath, JSON.stringify(aliasMap));
  return { root, configPath, toolMapPath };
}
function cli(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

afterEach(() => {
  fault.failCommit = false;
  fault.commits = 0;
  fault.failWrite = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("one-time native MCP migration", () => {
  it("converts both supported transports, exact/ceil timeouts, literals and disabled state", () => {
    // Intent: verify actual native shape without expanding credentials or shell strings.
    const source = legacy();
    const untouched = structuredClone(source);
    const result = convertConfig(source);
    expect(result.native).toEqual({ mcpServers: {
      files: {
        command: "runner", args: ["--arg", "${UNCHANGED}"], env: source.mcp.servers.files.env,
        cwd: "${ROOT}/path", timeout: 2, exposure: "direct",
      },
      web: { url: "https://example.test/mcp", headers: source.mcp.servers.web.headers,
        timeout: 3, enabled: false, exposure: "direct" },
    } });
    expect(result.config.mcp).toBeUndefined();
    expect(result.config.notify).toEqual(source.notify);
    expect(result.warnings.join(" ")).toContain("startupTimeoutMs");
    expect(result.warnings.join(" ")).toContain("toolPrefix");
    expect(result.warnings.join(" ")).not.toContain("literal-secret");
    expect(source).toEqual(untouched);
  });

  it("merges unrelated content and is idempotent, but rejects differing same-name entries", () => {
    // Intent: existing native servers and global controls must not be overwritten.
    const existing = { autoEnableCodemode: false, custom: { keep: true }, mcpServers: { other: { command: "other" } } };
    const result = convertConfig(legacy(), existing);
    expect(result.native.autoEnableCodemode).toBe(false);
    expect(result.native.mcpServers.other).toEqual({ command: "other" });
    expect(convertConfig(legacy(), result.native).native).toEqual(result.native);
    expect(convertConfig(result.config, result.native).native).toEqual(result.native);
    expect(convertConfig(result.config, result.native).warnings).toEqual([]);
    expect(() => convertConfig(legacy(), { mcpServers: { files: { command: "different" } } })).toThrow(/differs/);
    expect(existing).toEqual({ autoEnableCodemode: false, custom: { keep: true }, mcpServers: { other: { command: "other" } } });
  });

  it.each(["sse", "websocket", "ws", "unknown"])("rejects unsupported %s transport without fallback", (transport) => {
    // Intent: rejecting every unsupported remote protocol prevents accidental endpoint changes.
    const source = legacy();
    source.mcp.servers.web.transport = transport;
    expect(() => convertConfig(source)).toThrow(/only streamable-http/);
  });

  it.each([0, -1, 1.2, NaN, Infinity])("rejects invalid timeout %s", (timeout) => {
    // Intent: invalid units/values must not silently become different runtime behavior.
    const source = legacy();
    source.mcp.callTimeoutMs = timeout;
    expect(() => convertConfig(source)).toThrow(/positive safe integer/);
  });

  it("rejects malformed command, invalid server names and unknown fields", () => {
    // Intent: unsupported configuration cannot disappear unnoticed during conversion.
    expect(() => convertConfig({ mcp: { servers: { a: { type: "local", command: "shell cmd" } } } })).toThrow(/command array/);
    expect(() => convertConfig({ mcp: { servers: { "bad.name": { type: "local", command: ["x"] } } } })).toThrow(/server name/);
    expect(() => convertConfig({ mcp: { servers: { a: { type: "local", command: ["x"], unknown: true } } } })).toThrow(/Unknown/);
    expect(() => convertConfig({ mcp: { servers: null } })).toThrow(/JSON object/);
    expect(() => convertConfig({ mcp: { servers: { a: { type: "local", command: ["x"], callTimeoutMs: null } } } })).toThrow(/positive/);
  });

  it("renames only explicit permission/render keys, retaining pattern rules and unrelated data", () => {
    // Intent: substring replacements would corrupt or weaken permission rules.
    const input = {
      permission: { old_read: { "old_read/**": "deny" }, old_read_extra: "ask", "*": "deny" },
      render: { collapsedToolResultLines: { old_read: 7 }, collapsedToolResultMaxChars: 500 },
      text: "old_read", nested: { permission: { old_read: "allow" } },
    };
    expect(renameConfigReferences(input, aliasMap)).toEqual({
      ...input, permission: { mcp__files__read: { "old_read/**": "deny" }, old_read_extra: "ask", "*": "deny" },
      render: { collapsedToolResultLines: { mcp__files__read: 7 }, collapsedToolResultMaxChars: 500 },
    });
    expect(input.permission.old_read).toEqual({ "old_read/**": "deny" });
  });

  it("rejects map ambiguity, key collisions (even equal rules), and wildcard tool keys", () => {
    // Intent: do not coalesce potentially distinct permission/render identities.
    expect(() => validateToolMap({ a: "mcp__files__read", b: "mcp__files__read" })).toThrow(/colliding/);
    expect(() => validateToolMap({ a: "mcp__files__read", mcp__files__read: "mcp__files__write" })).toThrow(/Ambiguous/);
    expect(() => validateToolMap({ a: "read" })).toThrow(/Invalid/);
    for (const input of [
      { permission: { old_read: "deny", mcp__files__read: "deny" } },
      { render: { collapsedToolResultLines: { old_read: 1, mcp__files__read: 1 } } },
      { permission: { "old_*": "deny" } },
    ]) expect(() => renameConfigReferences(input, aliasMap)).toThrow(/collision|Wildcard/);
  });

  it("accepts discovered truncated/hash-suffixed names but rejects overlong tool identifiers", () => {
    // Intent: native naming may truncate away the server/tool separator; never reconstruct names.
    const target = `mcp__${"a".repeat(50)}_1234abcd`;
    expect(target).toHaveLength(64);
    expect(validateToolMap({ old_read: target })).toEqual({ old_read: target });
    expect(() => validateToolMap({ old_read: `${target}x` })).toThrow(/Invalid/);
  });

  it.each([
    "---\nname: agent\ntools: [read, 'old_read']\n---\n",
    '---\r\nname: agent\r\ntools:\r\n  - read\r\n  - "old_read"\r\n---\r\n',
  ])("renames agent YAML tools and exact prompt/skill tokens without substring edits", (header) => {
    // Intent: both list styles and CRLF preserve non-tool content and prefix/suffix names.
    const input = `${header}Use \`old_read\`, not old_read_extra, pre_old_read, old_read-extra or old_read.md.`;
    const updated = renameMarkdown(input, aliasMap);
    expect(updated).toBe(input.replace("'old_read'", "'mcp__files__read'").replace('"old_read"', '"mcp__files__read"').replace("`old_read`", "`mcp__files__read`"));
    expect(renameMarkdown(updated, aliasMap)).toBe(updated);
  });

  it("rejects ambiguous agent allowlists and unsupported YAML", () => {
    // Intent: an explicit allowlist must not gain or collapse capabilities accidentally.
    expect(() => renameMarkdown("---\ntools: [old_read, mcp__files__read]\n---\n", aliasMap)).toThrow(/collision/);
    expect(() => renameMarkdown("---\ntools: [old_read]\ntools: [read]\n---\n", aliasMap)).toThrow(/Duplicate/);
    expect(() => renameMarkdown("---\ntools: &shared [old_read]\n---\n", aliasMap)).toThrow(/Unsupported/);
    expect(() => renameMarkdown('---\n"tools": [old_read, mcp__files__read]\n---\n', aliasMap)).toThrow(/Unsupported/);
    expect(() => renameMarkdown("\uFEFF---\ntools:\n  - old_read\n\n  # comment\n  - mcp__files__read\n---\n", aliasMap)).toThrow(/collision/);
    expect(() => renameMarkdown("---\ntools: [old_read]\n", aliasMap)).toThrow(/incomplete/);
    expect(renameMarkdown("old_read and old_read_extra", {})).toBe("old_read and old_read_extra");
  });

  it("CLI default dry-run logs no secret values and changes no files", () => {
    // Intent: default invocation must be safe even with literal credentials present.
    const { root, configPath, toolMapPath } = fixture();
    const before = readFileSync(configPath, "utf8");
    const result = cli(["--config", configPath, "--tool-map", toolMapPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Dry-run: 2 affected file(s)");
    expect(result.stdout + result.stderr).not.toMatch(/literal-secret|\$SECRET|example\.test|runner|old_read/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(readdirSync(root).sort()).toEqual(["map.json", "pi-base.json"]);
  });

  it("applies a complete plan with private backups and permissions; second apply is a no-op", () => {
    // Intent: verify backups contain originals, all dependent references update, unrelated files stay intact.
    const { root, configPath, toolMapPath } = fixture();
    const agent = join(root, "agent.md");
    writeFileSync(agent, "---\ntools: [old_read, read]\n---\nUse old_read.\n");
    const rules = join(root, "rules.json");
    writeFileSync(rules, JSON.stringify({ permission: { old_read: "deny" } }));
    const nativePath = join(root, "mcp.json");
    writeFileSync(nativePath, JSON.stringify({ autoEnableCodemode: false, mcpServers: { other: { command: "keep" } } }));
    const untouched = ["history.json", "sessions.json", "auth.json", "models.json"];
    for (const name of untouched) writeFileSync(join(root, name), "do not touch");
    const originals = new Map([configPath, nativePath, agent, rules].map((path) => [path, readFileSync(path, "utf8")]));
    const args = ["--config", configPath, "--tool-map", toolMapPath, "--references", agent, "--references", rules, "--apply"];
    const result = cli(args);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8")).permission).toEqual({ mcp__files__read: "deny", read: "allow" });
    expect(readFileSync(agent, "utf8")).toContain("tools: [mcp__files__read, read]");
    expect(JSON.parse(readFileSync(rules, "utf8")).permission).toEqual({ mcp__files__read: "deny" });
    expect(JSON.parse(readFileSync(nativePath, "utf8")).autoEnableCodemode).toBe(false);
    const backups = readdirSync(root).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(4);
    for (const name of backups) {
      const backup = join(root, name);
      const target = backup.split(".mcp-migration-")[0];
      expect(readFileSync(backup, "utf8")).toBe(originals.get(target));
      if (process.platform !== "win32") {
        expect(statSync(backup).mode & 0o777).toBe(0o600);
        expect(statSync(target).mode & 0o777).toBe(0o600);
      }
    }
    const second = cli(args);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("0 affected file(s)");
    expect(readdirSync(root).filter((name) => name.endsWith(".bak"))).toHaveLength(4);
    for (const name of untouched) expect(readFileSync(join(root, name), "utf8")).toBe("do not touch");
  });

  it("creates a previously absent native file privately and backs up only existing affected files", () => {
    // Intent: newly created native configuration can contain secrets and must also be private.
    const { root, configPath, toolMapPath } = fixture();
    const result = cli(["--config", configPath, "--tool-map", toolMapPath, "--apply"]);
    expect(result.status).toBe(0);
    expect(readdirSync(root).filter((name) => name.endsWith(".bak"))).toHaveLength(1);
    if (process.platform !== "win32") expect(statSync(join(root, "mcp.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(root, "mcp.json"), "utf8")).mcpServers.files.exposure).toBe("direct");
  });

  it.each(["conflict", "transport", "reference", "invalid-json"])("planning failure (%s) under --apply writes nothing", (reason) => {
    // Intent: failures discovered late in the plan must not create a target or backup.
    const { root, configPath, toolMapPath } = fixture();
    const references: string[] = [];
    if (reason === "conflict") writeFileSync(join(root, "mcp.json"), '{"mcpServers":{"files":{"command":"conflict"}}}');
    if (reason === "transport") {
      const source = legacy();
      source.mcp.servers.web.transport = "sse";
      writeFileSync(configPath, JSON.stringify(source));
    }
    if (reason === "invalid-json") writeFileSync(configPath, '{"secret":"literal-secret",');
    if (reason === "reference") {
      const agent = join(root, "agent.md");
      writeFileSync(agent, "---\ntools: [old_read, mcp__files__read]\n---\n");
      references.push("--references", agent);
    }
    const before = new Map(readdirSync(root).map((name) => [name, readFileSync(join(root, name), "utf8")]));
    const result = cli(["--config", configPath, "--tool-map", toolMapPath, ...references, "--apply"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Migration failed");
    expect(result.stdout + result.stderr).not.toContain("literal-secret");
    expect(new Map(readdirSync(root).map((name) => [name, readFileSync(join(root, name), "utf8")]))).toEqual(before);
  });

  it("rejects duplicate JSON keys including escaped spellings before writes", () => {
    // Intent: JSON's last-key-wins behavior must not collapse conflicting security rules.
    const { root, configPath, toolMapPath } = fixture();
    const original = '{"permission":{"old_read":"deny","old_\\u0072ead":"allow"}}';
    writeFileSync(configPath, original);
    const result = cli(["--config", configPath, "--tool-map", toolMapPath, "--apply"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Duplicate JSON keys");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(readdirSync(root).some((name) => name.endsWith(".bak") || name === "mcp.json")).toBe(false);
  });

  it("rejects symlinks, duplicate targets and modified snapshots before writing", () => {
    // Intent: never replace linked files or apply a stale plan over newer user edits.
    const { root, configPath, toolMapPath } = fixture();
    symlinkSync(configPath, join(root, "link.json"));
    expect(() => planMigration({ configPath, references: [join(root, "link.json")] })).toThrow(/non-linked/);
    expect(() => planMigration({ configPath, references: [configPath] })).toThrow(/overlapping/);
    const plan = planMigration({ configPath, toolMapPath });
    writeFileSync(configPath, "{}");
    expect(() => applyMigration(plan)).toThrow(/changed since planning/);
    expect(readFileSync(configPath, "utf8")).toBe("{}");
    expect(readdirSync(root).some((name) => name.endsWith(".bak") || name.endsWith(".tmp"))).toBe(false);
  });

  it.each(["auth.json", "mcp-auth.json", "models.json", "history.json", "sessions.json"])("never migrates protected %s even if explicitly supplied", (name) => {
    // Intent: unrelated durable state is not a supported reference target.
    const { root, configPath, toolMapPath } = fixture();
    const path = join(root, name);
    const original = '{"permission":{"old_read":"deny"}}';
    writeFileSync(path, original);
    const result = cli(["--config", configPath, "--tool-map", toolMapPath, "--references", path, "--apply"]);
    expect(result.status).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(root).some((entry) => entry.endsWith(".bak") || entry === "mcp.json")).toBe(false);
  });

  it.each([false, true])("rolls back committed changes and removes staging files on commit failure (existing native: %s)", (nativeExists) => {
    // Intent: a filesystem failure after the first rename restores content and original mode.
    const { root, configPath, toolMapPath } = fixture();
    const original = readFileSync(configPath, "utf8");
    const mode = statSync(configPath).mode & 0o777;
    const nativePath = join(root, "mcp.json");
    const nativeOriginal = '{"autoEnableCodemode":false}';
    if (nativeExists) writeFileSync(nativePath, nativeOriginal, { mode: 0o640 });
    const nativeMode = nativeExists ? statSync(nativePath).mode & 0o777 : 0;
    const plan = planMigration({ configPath, toolMapPath });
    fault.failCommit = true;
    expect(() => applyMigration(plan)).toThrow(/Injected/);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    if (process.platform !== "win32") expect(statSync(configPath).mode & 0o777).toBe(mode);
    expect(readdirSync(root).some((name) => name.endsWith(".tmp") || name.endsWith(".rollback"))).toBe(false);
    if (nativeExists) {
      expect(readFileSync(nativePath, "utf8")).toBe(nativeOriginal);
      if (process.platform !== "win32") expect(statSync(nativePath).mode & 0o777).toBe(nativeMode);
    } else expect(readdirSync(root)).not.toContain("mcp.json");
    expect(readdirSync(root).filter((name) => name.endsWith(".bak"))).toHaveLength(nativeExists ? 2 : 1);
  });

  it.each([2, 3])("cleans partial backup/staging writes before any commit (%s)", (writeNumber) => {
    // Intent: even a disk write that creates a partial file cannot leave stale staging or replace input.
    const { root, configPath, toolMapPath } = fixture();
    const original = readFileSync(configPath, "utf8");
    const plan = planMigration({ configPath, toolMapPath });
    fault.failWrite = writeNumber;
    expect(() => applyMigration(plan)).toThrow(/Injected partial write/);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(readdirSync(root)).not.toContain("mcp.json");
    expect(readdirSync(root).some((name) => name.endsWith(".tmp") || name.endsWith(".rollback"))).toBe(false);
    for (const name of readdirSync(root).filter((entry) => entry.endsWith(".bak"))) {
      expect(readFileSync(join(root, name), "utf8")).toBe(original);
    }
  });
});
