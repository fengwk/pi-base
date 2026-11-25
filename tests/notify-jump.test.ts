import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/notify.sh");
const SERVER_PID = "101";
const SOCKET = "/tmp/pi notify tmux.sock";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The mock tmux keeps a small world model so the script's post-jump verification can
// observe the client it moved. Worlds use the same stable IDs tmux reports.
type World = {
  sessions: Array<{ id: string; name: string; window: string }>;
  windows: Array<{ id: string; session: string; index: string; active: string }>;
  panes: Array<{ id: string; session: string; window: string; index: string }>;
  clients: Array<{ tty: string; pid: string; session: string; window: string; pane: string }>;
  fail?: string[];
  noApply?: string[];
  serverPid?: string;
  requireSocket?: boolean;
  reuseTtyAfterSwitch?: boolean;
};

const MOCK = String.raw`#!__NODE__
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = process.env.MOCK_STATE;
const world = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const socket = args[0] === '-S' ? args.splice(0, 2)[1] : undefined;
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(['tmux'].concat(args)) + '\n');
if (world.requireSocket && socket !== process.env.MOCK_SOCKET) process.exit(1);
const serverPid = world.serverPid || process.env.MOCK_SERVER_PID;
const cmd = args[0];
const argOf = (flag) => { const at = args.indexOf(flag); return at < 0 ? '' : args[at + 1]; };
if ((world.fail || []).includes(cmd)) { process.stderr.write('mock ' + cmd + ' failure\n'); process.exit(1); }
const sessionOf = (id) => world.sessions.find((item) => item.id === id || item.name === id);
const windowOf = (id, session) => world.windows.find((item) => item.id === id && item.session === session);
const paneOf = (id, session) => world.panes.find((item) => item.id === id && item.session === session);
const render = (format, values) => format.replace(/#\{([a-z_]+)\}/g, (_, key) => String(values[key] === undefined ? '' : values[key]));
const describe = (pane) => {
  const session = sessionOf(pane.session);
  const window = windowOf(pane.window, pane.session);
  return {
    session_id: session.id, session_name: session.name,
    window_id: window.id, window_index: window.index,
    pane_id: pane.id, pane_index: pane.index,
  };
};
const skip = (name) => (world.noApply || []).includes(name);

if (cmd === 'list-panes') {
  const format = argOf('-F');
  world.panes.forEach((pane) => console.log(render(format, describe(pane))));
} else if (cmd === 'list-clients') {
  const format = argOf('-F');
  world.clients.forEach((client) => {
    console.log(render(format, Object.assign(
      { client_tty: client.tty, client_pid: client.pid, pid: serverPid }, describe(paneOf(client.pane, client.session)),
    )));
  });
} else if (cmd === 'switch-client') {
  if (!skip('switch-client')) {
    const session = sessionOf(argOf('-t'));
    const client = world.clients.find((item) => item.tty === argOf('-c'));
    if (!session || !client) { process.stderr.write('mock switch-client: unknown target\n'); process.exit(1); }
    client.session = session.id;
    client.window = session.window;
    client.pane = windowOf(session.window, session.id).active;
    if (world.reuseTtyAfterSwitch) client.pid = '999';
  }
} else if (cmd === 'select-window') {
  if (!skip('select-window')) {
    const [session, id] = argOf('-t').split(':');
    const window = windowOf(id, session);
    if (!window) { process.stderr.write('mock select-window: unknown window\n'); process.exit(1); }
    sessionOf(window.session).window = window.id;
    world.clients.forEach((client) => {
      if (client.session === window.session) { client.window = window.id; client.pane = window.active; }
    });
  }
} else if (cmd === 'select-pane') {
  if (!skip('select-pane')) {
    const [session, window, id] = argOf('-t').split(/[:.]/);
    const pane = paneOf(id, session);
    if (!pane || pane.window !== window) { process.stderr.write('mock select-pane: unknown pane\n'); process.exit(1); }
    world.windows.filter((item) => item.id === window).forEach((item) => { item.active = pane.id; });
    world.clients.forEach((client) => { if (client.window === pane.window) client.pane = pane.id; });
  }
} else if (cmd === 'display-message') {
  const format = args[args.length - 1];
  const client = world.clients[0];
  const view = client ? describe(paneOf(client.pane, client.session)) : {};
  console.log(render(format, { ...view, pid: serverPid, socket_path: process.env.MOCK_SOCKET }));
}

fs.writeFileSync(statePath, JSON.stringify(world));
`;

function makeWorld(): World {
  return {
    sessions: [
      { id: "$1", name: "pi", window: "@2" },
      { id: "$2", name: "ops", window: "@4" },
    ],
    windows: [
      { id: "@2", session: "$1", index: "1", active: "%2" },
      { id: "@3", session: "$1", index: "2", active: "%4" },
      { id: "@4", session: "$2", index: "1", active: "%6" },
      { id: "@5", session: "$2", index: "2", active: "%7" },
    ],
    panes: [
      { id: "%2", session: "$1", window: "@2", index: "1" },
      { id: "%3", session: "$1", window: "@2", index: "2" },
      { id: "%4", session: "$1", window: "@3", index: "1" },
      { id: "%5", session: "$1", window: "@3", index: "2" },
      { id: "%6", session: "$2", window: "@4", index: "1" },
      { id: "%7", session: "$2", window: "@5", index: "1" },
      { id: "%8", session: "$2", window: "@5", index: "2" },
    ],
    clients: [{ tty: "/dev/pts/10", pid: "201", session: "$1", window: "@2", pane: "%2" }],
  };
}

function execute(world: World, invocation: string | { code: string }, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-jump-"));
  dirs.push(dir);
  const state = join(dir, "world.json");
  const log = join(dir, "calls");
  writeFileSync(state, JSON.stringify(world));
  writeFileSync(log, "");
  const tmux = join(dir, "tmux");
  writeFileSync(tmux, MOCK.replace("__NODE__", process.execPath));
  chmodSync(tmux, 0o755);

  // The mock owns the only tmux on PATH, and TMUX/TMUX_PANE are cleared so the script
  // never reaches the developer's real server.
  const result = spawnSync(
    "bash",
    typeof invocation === "string" ? [script, invocation] : ["-c", invocation.code, "bash", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:/usr/bin:/bin`,
        MOCK_STATE: state,
        MOCK_LOG: log,
        MOCK_SOCKET: SOCKET,
        MOCK_SERVER_PID: SERVER_PID,
        TMUX: "",
        TMUX_PANE: "",
        PI_NOTIFY_TMUX_PANE: "",
        PI_NOTIFY_TMUX_TARGET: "",
        PI_NOTIFY_TMUX_CLIENT_TTY: "",
        PI_NOTIFY_TMUX_CONTEXT_BASE64: "",
        ...env,
      },
      timeout: 10_000,
    },
  );

  const calls: string[][] = readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line));
  const mutations = calls.filter((call) => ["switch-client", "select-window", "select-pane"].includes(call[1]));
  const finalWorld: World = JSON.parse(readFileSync(state, "utf8"));
  return { result, calls, mutations, finalWorld };
}

function jump(world: World, target: string, tty = "/dev/pts/10", capturedPid = world.clients.find((client) => client.tty === tty)?.pid ?? "201") {
  return execute(world, "jump", {
    PI_NOTIFY_TMUX_TARGET: target,
    PI_NOTIFY_TMUX_CLIENT_TTY: tty,
    PI_NOTIFY_TMUX_CONTEXT_BASE64: target.startsWith("$") ? Buffer.from(`${SERVER_PID}|${capturedPid}|${SOCKET}`).toString("base64") : "",
  });
}

describe("notification tmux jump", () => {
  it("switches session, then window, then pane when all three differ", () => {
    // The stale client sits in $1:@2 and the target lives in another session and window.
    const world = makeWorld();
    world.requireSocket = true;
    const { result, mutations, finalWorld } = jump(world, "$2:@5.%8");
    expect(result.status, result.stderr).toBe(0);
    expect(mutations).toEqual([
      ["tmux", "switch-client", "-c", "/dev/pts/10", "-t", "$2"],
      ["tmux", "select-window", "-t", "$2:@5"],
      ["tmux", "select-pane", "-t", "$2:@5.%8"],
    ]);
    expect(finalWorld.clients[0]).toMatchObject({ session: "$2", window: "@5", pane: "%8" });
  });

  it("keeps the session when only the window and pane differ", () => {
    // Selecting the window already activates %4 in @3, so only the pane step remains.
    const { result, mutations } = jump(makeWorld(), "$1:@3.%5");
    expect(result.status).toBe(0);
    expect(mutations).toEqual([
      ["tmux", "select-window", "-t", "$1:@3"],
      ["tmux", "select-pane", "-t", "$1:@3.%5"],
    ]);
  });

  it("selects only the pane when the window already matches", () => {
    const { result, mutations } = jump(makeWorld(), "$1:@2.%3");
    expect(result.status).toBe(0);
    expect(mutations).toEqual([["tmux", "select-pane", "-t", "$1:@2.%3"]]);
  });

  it("runs no tmux mutation when the client already shows the target", () => {
    // Idempotent jump: nothing to switch, so other clients of the session are left alone.
    const { result, mutations } = jump(makeWorld(), "$1:@2.%2");
    expect(result.status).toBe(0);
    expect(mutations).toEqual([]);
  });

  it("finds a pane that moved into another window after the notification", () => {
    // %8 now lives in $2:@5; the captured $1:@2 prefix is stale but the pane ID still resolves.
    const world = makeWorld();
    world.panes = world.panes
      .filter((pane) => pane.id !== "%8")
      .concat([{ id: "%8", session: "$2", window: "@5", index: "2" }]);
    const { result, mutations } = jump(world, "$1:@2.%8");
    expect(result.status).toBe(0);
    expect(mutations).toEqual([
      ["tmux", "switch-client", "-c", "/dev/pts/10", "-t", "$2"],
      ["tmux", "select-window", "-t", "$2:@5"],
      ["tmux", "select-pane", "-t", "$2:@5.%8"],
    ]);
  });

  it("uses the captured session for a window linked into two sessions", () => {
    // @5 is also visible from $1, but selecting it there would move a different session.
    const world = makeWorld();
    world.windows.unshift({ id: "@5", session: "$1", index: "3", active: "%7" });
    world.panes.unshift({ id: "%8", session: "$1", window: "@5", index: "2" });
    const { result, mutations, finalWorld } = jump(world, "$2:@5.%8");
    expect(result.status, result.stderr).toBe(0);
    expect(mutations.slice(1)).toEqual([
      ["tmux", "select-window", "-t", "$2:@5"],
      ["tmux", "select-pane", "-t", "$2:@5.%8"],
    ]);
    expect(finalWorld.sessions[0]?.window).toBe("@2");
  });

  it("prefers the client captured at notification time over a lower PID", () => {
    // Both clients share the target session; only the captured tty may be moved.
    const world = makeWorld();
    world.clients = [
      { tty: "/dev/pts/10", pid: "201", session: "$1", window: "@2", pane: "%2" },
      { tty: "/dev/pts/11", pid: "999", session: "$1", window: "@3", pane: "%4" },
    ];
    const { result, mutations } = jump(world, "$2:@5.%8", "/dev/pts/11");
    expect(result.status).toBe(0);
    expect(mutations[0]).toEqual(["tmux", "switch-client", "-c", "/dev/pts/11", "-t", "$2"]);
  });

  it("breaks same-priority ties by numeric PID", () => {
    // The captured client is gone; both remaining clients are on the target session, so
    // PID 111 wins over 999. Only the winning client needs a window switch, which makes
    // the choice observable.
    const world = makeWorld();
    world.clients = [
      { tty: "/dev/pts/12", pid: "999", session: "$1", window: "@2", pane: "%2" },
      { tty: "/dev/pts/13", pid: "111", session: "$1", window: "@3", pane: "%4" },
    ];
    const { result, mutations } = jump(world, "$1:@2.%3", "/dev/pts/99");
    expect(result.status).toBe(0);
    expect(mutations).toEqual([
      ["tmux", "select-window", "-t", "$1:@2"],
      ["tmux", "select-pane", "-t", "$1:@2.%3"],
    ]);
  });

  it("refuses to drag an unrelated terminal when the captured client is gone", () => {
    // Two unrelated clients: neither belongs to the target session, so hijacking one
    // would move a terminal the notification does not describe.
    const world = makeWorld();
    world.clients = [
      { tty: "/dev/pts/10", pid: "201", session: "$1", window: "@2", pane: "%2" },
      { tty: "/dev/pts/11", pid: "202", session: "$1", window: "@3", pane: "%4" },
    ];
    const { result, mutations } = jump(world, "$2:@5.%8", "/dev/pts/99");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no attached tmux client to switch to the target");
    expect(mutations).toEqual([]);
  });

  it("falls back to the only attached client", () => {
    const { result, mutations } = jump(makeWorld(), "$2:@5.%8", "/dev/pts/99");
    expect(result.status).toBe(0);
    expect(mutations[0]).toEqual(["tmux", "switch-client", "-c", "/dev/pts/10", "-t", "$2"]);
  });

  it("rejects stable IDs from a replaced server even when the same IDs still exist", () => {
    const world = makeWorld();
    world.serverPid = "102";
    const { result, mutations } = jump(world, "$2:@5.%8");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tmux server changed since the notification");
    expect(mutations).toEqual([]);
  });

  it("does not try the default server when a stable callback loses its context", () => {
    const { result, calls } = execute(makeWorld(), "jump", { PI_NOTIFY_TMUX_TARGET: "$2:@5.%8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing captured server context");
    expect(calls).toEqual([]);
  });

  it("does not treat a new client reusing the source tty as a fallback", () => {
    const world = makeWorld();
    const { result, mutations } = jump(world, "$2:@5.%8", "/dev/pts/10", "999");
    expect(result.status).toBe(1);
    expect(mutations).toEqual([]);
  });

  it("stops if a different client takes over the selected tty during the jump", () => {
    const world = makeWorld();
    world.reuseTtyAfterSwitch = true;
    const { result, mutations } = jump(world, "$2:@5.%8");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the selected client disappeared");
    expect(mutations.map((call) => call[1])).toEqual(["switch-client"]);
  });

  it("reports a target pane that no longer exists", () => {
    const { result, mutations } = jump(makeWorld(), "$2:@5.%9");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("target pane no longer exists");
    expect(mutations).toEqual([]);
  });

  it("stops at a failing switch-client and leaves the window selection alone", () => {
    const world = makeWorld();
    world.fail = ["switch-client"];
    const { result, mutations } = jump(world, "$2:@5.%8");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tmux switch-client failed");
    expect(mutations.map((call) => call[1])).toEqual(["switch-client"]);
  });

  it("stops at a failing select-window and does not select the pane", () => {
    const world = makeWorld();
    world.fail = ["select-window"];
    const { result, mutations } = jump(world, "$2:@5.%8");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tmux select-window failed");
    expect(mutations.map((call) => call[1])).toEqual(["switch-client", "select-window"]);
  });

  it("reports a jump whose selection did not actually take effect", () => {
    // Every command succeeds, but the client never reaches the target pane.
    const world = makeWorld();
    world.noApply = ["select-pane"];
    const { result } = jump(world, "$2:@5.%8");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not display the target pane");
  });

  it("still accepts a target captured before the stable-ID upgrade", () => {
    const { result, mutations } = jump(makeWorld(), "ops:2.2");
    expect(result.status).toBe(0);
    expect(mutations).toEqual([
      ["tmux", "switch-client", "-c", "/dev/pts/10", "-t", "$2"],
      ["tmux", "select-window", "-t", "$2:@5"],
      ["tmux", "select-pane", "-t", "$2:@5.%8"],
    ]);
  });

  it("does not capture the current pane when the actual source pane is gone", () => {
    // The shell still has a live tmux environment, but the original pane no longer exists.
    const { result } = execute(
      makeWorld(),
      { code: 'source "$1"; resolve_jump_context; printf "%s" "$JUMP_TMUX_TARGET"' },
      { PI_NOTIFY_TMUX_PANE: "%99", TMUX: `${SOCKET},${SERVER_PID},0` },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});
