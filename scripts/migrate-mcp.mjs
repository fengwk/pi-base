#!/usr/bin/env node
// One-time, offline migration. No Pi imports, server connections, or secret expansion.
import { readFileSync, lstatSync, writeFileSync, renameSync, unlinkSync, chmodSync, openSync, closeSync, fchmodSync } from "node:fs";
import { basename, dirname, resolve, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";

const own = (value, key) => Object.hasOwn(value, key);
class MigrationError extends Error {}
const fail = (message) => { throw new MigrationError(message); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function requireObject(value) {
  if (!object(value)) fail("Expected a JSON object.");
}
function keysOnly(value, keys) {
  requireObject(value);
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("Unknown legacy MCP field; manual review required.");
}
function positive(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail("Timeout must be a positive safe integer in milliseconds.");
}
function strings(value) {
  requireObject(value);
  if (Object.values(value).some((entry) => typeof entry !== "string")) fail("Expected string values.");
}

/** Pure conversion, preserving unrelated fields and rejecting conflicting server names. */
export function convertConfig(source, existing = {}) {
  requireObject(source);
  requireObject(existing);
  if (existing.mcpServers !== undefined) requireObject(existing.mcpServers);
  const config = structuredClone(source);
  const native = structuredClone(existing);
  const warnings = [];
  if (!own(source, "mcp")) return { config, native, warnings };
  const old = source.mcp;
  keysOnly(old, ["servers", "callTimeoutMs", "startupTimeoutMs"]);
  if (old.servers !== undefined) requireObject(old.servers);
  for (const key of ["callTimeoutMs", "startupTimeoutMs"]) {
    if (old[key] !== undefined) positive(old[key]);
  }
  if (old.startupTimeoutMs !== undefined) warnings.push("startupTimeoutMs has no native equivalent and is omitted.");
  native.mcpServers ??= {};
  for (const [name, server] of Object.entries(old.servers ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) {
      fail("Invalid native server name; manual review required.");
    }
    keysOnly(server, server?.type === "local"
      ? ["type", "command", "env", "cwd", "enabled", "toolPrefix", "startupTimeoutMs", "callTimeoutMs"]
      : ["type", "transport", "url", "headers", "enabled", "toolPrefix", "startupTimeoutMs", "callTimeoutMs"]);
    const converted = { exposure: "direct" };
    if (server.type === "local") {
      if (!Array.isArray(server.command) || !server.command.length
        || server.command.some((part) => typeof part !== "string" || !part.trim())) fail("Invalid local command array.");
      converted.command = server.command[0];
      converted.args = server.command.slice(1);
      if (server.env !== undefined) { strings(server.env); converted.env = structuredClone(server.env); }
      if (server.cwd !== undefined) {
        if (typeof server.cwd !== "string") fail("Invalid cwd.");
        converted.cwd = server.cwd;
      }
    } else if (server.type === "remote") {
      if (server.transport !== "streamable-http") fail("Unsupported remote transport; only streamable-http can be migrated.");
      if (typeof server.url !== "string") fail("Invalid remote URL.");
      try {
        if (!["http:", "https:"].includes(new URL(server.url).protocol)) fail("Invalid remote URL.");
      } catch { fail("Invalid remote URL."); }
      converted.url = server.url;
      if (server.headers !== undefined) { strings(server.headers); converted.headers = structuredClone(server.headers); }
    } else fail("Unsupported legacy server type.");
    if (server.enabled !== undefined) {
      if (typeof server.enabled !== "boolean") fail("Invalid enabled flag.");
      converted.enabled = server.enabled;
    }
    if (server.toolPrefix !== undefined && typeof server.toolPrefix !== "string") fail("Invalid toolPrefix.");
    warnings.push("Legacy aliases/toolPrefix are not supported; supply a verified --tool-map (no automatic discovery).");
    if (server.startupTimeoutMs !== undefined) {
      positive(server.startupTimeoutMs);
      warnings.push("Server startupTimeoutMs has no native equivalent and is omitted.");
    }
    if (server.callTimeoutMs !== undefined) positive(server.callTimeoutMs);
    const timeout = server.callTimeoutMs ?? old.callTimeoutMs;
    if (timeout !== undefined) { positive(timeout); converted.timeout = Math.ceil(timeout / 1000); }
    if (own(native.mcpServers, name) && !isDeepStrictEqual(native.mcpServers[name], converted)) {
      fail("Same-name native server differs; no files changed.");
    }
    Object.defineProperty(native.mcpServers, name, { value: converted, enumerable: true, configurable: true, writable: true });
  }
  warnings.push("Literal env/cwd/headers are copied without expansion. Review native ${NAME}/!command semantics before connecting.");
  delete config.mcp;
  return { config, native, warnings: [...new Set(warnings)] };
}

export function validateToolMap(map) {
  requireObject(map);
  const targets = new Set();
  for (const [alias, target] of Object.entries(map)) {
    if (!/^[A-Za-z0-9_-]+$/.test(alias) || ["__proto__", "constructor", "prototype"].includes(alias)
      || typeof target !== "string" || target.length > 64
      || !(/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(target)
        || /^mcp__[A-Za-z0-9_-]+_[0-9a-f]{8}$/.test(target))) fail("Invalid tool map identifier.");
    if (targets.has(target) || (alias !== target && own(map, target))) fail("Ambiguous or colliding tool map.");
    targets.add(target);
  }
  return map;
}

function renameKeys(value, map) {
  if (!object(value)) return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    // Nontrivial wildcard rules may change meaning across the namespace boundary.
    if (Object.keys(map).length && key !== "*" && /[*?[\]]/.test(key)) fail("Wildcard tool rules need manual migration.");
    const target = own(map, key) ? map[key] : key;
    if (own(result, target) || (target !== key && own(value, target))) fail("Reference key collision; no files changed.");
    Object.defineProperty(result, target, { value: entry, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

/** Only exact tool keys; permission pattern strings and unrelated JSON remain untouched. */
export function renameConfigReferences(input, toolMap) {
  const map = validateToolMap(toolMap);
  requireObject(input);
  const result = structuredClone(input);
  if (result.permission !== undefined) result.permission = renameKeys(result.permission, map);
  if (object(result.render)) {
    for (const key of ["collapsedToolResultLines", "collapsedToolResultMaxChars"]) {
      if (result.render[key] !== undefined) result.render[key] = renameKeys(result.render[key], map);
    }
  }
  return result;
}

function yamlTool(token) {
  const match = token.trim().match(/^(?:([A-Za-z0-9_-]+)|"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)')$/);
  if (!match) fail("Unsupported YAML tools syntax; use a simple inline or block string list.");
  return match[1] ?? match[2] ?? match[3];
}

/** Token-boundary replacement only, including simple YAML tools lists in agents. */
export function renameMarkdown(text, toolMap) {
  const map = validateToolMap(toolMap);
  if (!Object.keys(map).length) return text;
  const frontmatter = text.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (/^(?:\uFEFF)?---\r?\n/.test(text) && !frontmatter) fail("Unsupported or incomplete YAML frontmatter.");
  if (frontmatter) {
    const lines = frontmatter[1].split(/\r?\n/);
    if (lines.some((line) => /^\s*["']tools["']\s*:|^\s+tools\s*:/.test(line))) {
      fail("Unsupported YAML tools syntax.");
    }
    const declarations = lines.filter((line) => /^tools\s*:/.test(line));
    if (declarations.length > 1) fail("Duplicate YAML tools declarations.");
    for (let i = 0; i < lines.length; i++) {
      if (!/^tools\s*:/.test(lines[i])) continue;
      const tail = lines[i].slice(lines[i].indexOf(":") + 1).trim();
      let tools;
      if (tail) {
        if (!tail.startsWith("[") || !tail.endsWith("]")) fail("Unsupported YAML tools syntax.");
        tools = tail.slice(1, -1).trim() ? tail.slice(1, -1).split(",").map(yamlTool) : [];
      } else {
        tools = [];
        while (i + 1 < lines.length) {
          const next = lines[i + 1];
          if (!next.trim() || /^\s*#/.test(next)) { i++; continue; }
          if (/^\s+-\s+/.test(next)) {
            tools.push(yamlTool(lines[++i].replace(/^\s+-\s+/, "")));
          } else {
            if (/^\s/.test(next)) fail("Unsupported YAML tools syntax.");
            break;
          }
        }
        if (!tools.length) fail("Unsupported YAML tools syntax.");
      }
      const renamed = tools.map((tool) => own(map, tool) ? map[tool] : tool);
      if (new Set(renamed).size !== renamed.length) fail("YAML tools collision.");
    }
  }
  // A simultaneous replacement prevents chained substitutions and partial-name edits.
  return text.replace(/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g, (token) => own(map, token) ? map[token] : token);
}

function snapshot(path, optional = false) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("Migration targets must be regular, non-linked files.");
    return readFileSync(path, "utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
}
function json(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail("Invalid JSON input (contents redacted)."); }
  // JSON.parse silently takes the last duplicate key; that can weaken permission rules.
  // Syntax is already validated, so only string/punctuation tokens need to be inspected.
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}[\]:,]/g) ?? [];
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const key = JSON.parse(token);
      const keys = stack.at(-1);
      if (keys.has(key)) fail("Duplicate JSON keys are ambiguous; no files changed.");
      keys.add(key);
    }
  }
  return parsed;
}
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function writePrivate(path, contents) {
  const fd = openSync(path, "wx", 0o600);
  let complete = false;
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, contents);
    complete = true;
  } finally {
    closeSync(fd);
    if (!complete) unlinkSync(path);
  }
}

/** Build the complete plan before creating any backups or files. */
export function planMigration({ configPath, toolMapPath, references = [] }) {
  const sourcePath = resolve(configPath);
  if (basename(sourcePath) !== "pi-base.json") fail("--config must name pi-base.json.");
  const nativePath = resolve(dirname(sourcePath), "mcp.json");
  const before = snapshot(sourcePath);
  const nativeBefore = snapshot(nativePath, true);
  const map = validateToolMap(toolMapPath ? json(snapshot(resolve(toolMapPath))) : {});
  const converted = convertConfig(json(before), nativeBefore === null ? {} : json(nativeBefore));
  const changes = [];
  function add(path, previous, next) {
    if (previous !== next) changes.push({ path, before: previous, after: next });
  }
  const updated = renameConfigReferences(converted.config, map);
  add(sourcePath, before, isDeepStrictEqual(json(before), updated) ? before : serialize(updated));
  if (!isDeepStrictEqual(nativeBefore === null ? {} : json(nativeBefore), converted.native)) {
    add(nativePath, nativeBefore, serialize(converted.native));
  }
  const seen = new Set([sourcePath, nativePath, ...(toolMapPath ? [resolve(toolMapPath)] : [])]);
  for (const reference of references) {
    const path = resolve(reference);
    if (["auth.json", "mcp-auth.json", "model.json", "models.json", "history.json", "histories.json", "session.json", "sessions.json"].includes(basename(path).toLowerCase())
      || dirname(path).split(sep).some((part) => ["sessions", "history", "histories"].includes(part.toLowerCase()))) {
      fail("History/session/auth/model files are outside migration scope.");
    }
    if (seen.has(path)) fail("Duplicate or overlapping migration input.");
    seen.add(path);
    const previous = snapshot(path);
    const extension = extname(path).toLowerCase();
    let next;
    if (extension === ".json") {
      const input = json(previous);
      const renamed = renameConfigReferences(input, map);
      next = isDeepStrictEqual(input, renamed) ? previous : serialize(renamed);
    } else if (extension === ".md") next = renameMarkdown(previous, map);
    else fail("References must be .json or .md files.");
    add(path, previous, next);
  }
  // Publish native configuration/references first; remove the legacy block last.
  changes.sort((a, b) => Number(a.path === sourcePath) - Number(b.path === sourcePath));
  return { changes, warnings: converted.warnings, aliases: Object.keys(map).length };
}

/** Private backups and staging, with rollback on a write failure. */
export function applyMigration(plan) {
  const id = randomUUID();
  const staged = [];
  const backups = [];
  const committed = [];
  try {
    for (const change of plan.changes) {
      if (snapshot(change.path, true) !== change.before) fail("Input changed since planning; no migration applied.");
    }
    for (const change of plan.changes) {
      if (change.before !== null) {
        const backup = `${change.path}.mcp-migration-${id}.bak`;
        writePrivate(backup, change.before);
        backups.push(backup);
      }
      const path = `${change.path}.mcp-migration-${id}.tmp`;
      const mode = change.before === null ? 0o600 : lstatSync(change.path).mode & 0o777;
      writePrivate(path, change.after);
      staged.push({ path, change, mode });
    }
    for (const { path, change, mode } of staged) {
      if (snapshot(change.path, true) !== change.before) fail("Input changed during migration.");
      renameSync(path, change.path);
      committed.push({ ...change, mode });
    }
    return backups;
  } catch (error) {
    for (const change of committed.reverse()) {
      if (change.before === null) unlinkSync(change.path);
      else {
        const rollback = `${change.path}.mcp-migration-${id}.rollback`;
        writePrivate(rollback, change.before);
        chmodSync(rollback, change.mode);
        renameSync(rollback, change.path);
      }
    }
    throw error;
  } finally {
    for (const { path } of staged) {
      try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}

export function main(args = process.argv.slice(2)) {
  const options = { references: [] };
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") {
      console.log("node scripts/migrate-mcp.mjs --config <pi-base.json> [--tool-map <input.json>] [--references <file> (repeatable)] [--apply]");
      return;
    }
    if (arg === "--apply" && !apply) { apply = true; continue; }
    const key = { "--config": "configPath", "--tool-map": "toolMapPath", "--references": "references" }[arg];
    if (!key || !args[i + 1] || args[i + 1].startsWith("--")) fail("Invalid CLI arguments; use --help.");
    const value = args[++i];
    if (key === "references") options.references.push(value);
    else {
      if (options[key]) fail("Duplicate CLI option.");
      options[key] = value;
    }
  }
  if (!options.configPath) fail("--config is required; no implicit user-directory access.");
  const plan = planMigration(options);
  console.log(`${apply ? "Apply" : "Dry-run"}: ${plan.changes.length} affected file(s); ${plan.aliases} explicit alias(es). Configuration values are redacted.`);
  for (const warning of plan.warnings) console.log(`Warning: ${warning}`);
  if (apply) console.log(`Applied; ${applyMigration(plan).length} private backup(s) created beside affected files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    // Never echo filesystem errors, configuration values, URLs, or supplied secrets.
    console.error(`Migration failed: ${error instanceof MigrationError ? error.message : "Filesystem failure (details redacted)."} Review inputs and backups before retrying.`);
    process.exitCode = 1;
  }
}
