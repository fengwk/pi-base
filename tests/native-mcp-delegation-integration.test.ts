import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/native-mcp-delegation.mjs", import.meta.url));

it("accepts the complete real JITI task/MCP delegation in an isolated Node process", async () => {
  // JITI must not execute pi-base a second time inside Vitest's V8 coverage process.
  // execFile does not inherit execArgv; also remove environment-based coverage/preloads.
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_OPTIONS;
  let output;
  try {
    output = await execute(process.execPath, [fixture], {
      env, encoding: "utf8", timeout: 30_000, killSignal: "SIGTERM", maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const failure = error as Error & {
      code?: string | number; signal?: string; killed?: boolean; stdout?: string; stderr?: string;
    };
    throw new Error(
      `Native MCP delegation subprocess failed (code=${failure.code}, signal=${failure.signal}, killed=${failure.killed}).`
      + `\nstdout:\n${failure.stdout ?? ""}\nstderr:\n${failure.stderr ?? ""}`,
      { cause: error },
    );
  }
  // Successful execFile resolution requires exit code 0. Treat unexpected stderr as failure
  // too, and require the summary emitted only after every fixture assertion and cleanup.
  expect(output.stderr).toBe("");
  expect(JSON.parse(output.stdout.trim())).toEqual({
    status: "passed", sdkVersion: "0.99.1", report: "Echo report: delegated-echo",
    childTool: "mcp__fixture__echo", independentConnections: 2, serversExited: 2,
  });
}, 40_000);
