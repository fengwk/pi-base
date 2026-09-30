import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Each test worker owns an empty agent directory: real user settings, credentials
// and session files must never affect tests or receive test writes.
const agentDir = mkdtempSync(join(tmpdir(), "pi-base-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_BASE_GLOBAL_SETTINGS_PATH = join(agentDir, "pi-base.json");
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));
