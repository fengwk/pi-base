import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/notify.sh");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Source pane %7 lives in session $1; the server PID is 101 throughout.
const SOURCE_PANE = "%7";
const DEFAULT_SERVER = "101";
const DEFAULT_PANES = "%7|$1|@4\n";
const DEFAULT_CLIENTS = "/dev/pts/10|201|$1|%8\n/dev/pts/11|202|$2|%9\n";
const CROSS_SESSION_CLIENTS = "/dev/pts/10|201|$2|%9\n/dev/pts/11|202|$1|%8\n";
const MOCK_SOCKET = "/tmp/mock-tmux.sock";

// A D-Bus reply is either a plain stdout string or an explicit exit/output pair so tests
// can tell "(false,)" (no local window) apart from an extension/transport error, which
// may also carry stderr that the script must preserve in its diagnostic.
type DbusResult = string | { out?: string; exit?: number; err?: string };

type Scenario = {
  action?: string;
  actionUnavailable?: boolean;
  beforePanes?: string;
  afterPanes?: string;
  latePanes?: string;
  beforeClients?: string;
  afterClients?: string;
  lateClients?: string;
  beforeServer?: string;
  afterServer?: string;
  lateServer?: string;
  lateOn?: "switch-client" | "gdbus";
  failCommand?: string;
  lateFailCommand?: string;
  dbus?: Record<string, DbusResult>;
  dbusDefault?: string;
};

function run(scenario: Scenario = {}, env: Record<string, string> = {}) {
  // Intent: drive the real shell path while every desktop signal/tmux call goes through a
  // deterministic mock. The mock python3 helper publishes the click and flips the phase to
  // "after", so capture-time and click-time tmux state stay separate.
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  dirs.push(dir);
  const log = join(dir, "calls");
  const state = join(dir, "clicked");
  const data = join(dir, "scenario.json");
  writeFileSync(data, JSON.stringify(scenario));
  const mock = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),cmd=path.basename(process.argv[1]);
const s=JSON.parse(fs.readFileSync(process.env.MOCK_DATA,'utf8'));
fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify([cmd,...args])+'\\n');
const late=fs.existsSync(process.env.MOCK_LATE_STATE);
const phase=fs.existsSync(process.env.MOCK_STATE)?'after':'before';
const DEFAULT_PANES=${JSON.stringify(DEFAULT_PANES)};
const DEFAULT_CLIENTS=${JSON.stringify(DEFAULT_CLIENTS)};
if(cmd==='notify-send') {
  if(args.includes('-A')) {
    fs.writeFileSync(process.env.MOCK_STATE,'yes');
    process.stdout.write(s.action||'');
  }
} else if(cmd==='python3') {
  fs.writeFileSync(process.env.MOCK_STATE,'yes');
  process.exit(s.actionUnavailable?2:s.action==='default'?0:3);
} else if(cmd==='tmux') {
  if(args[0]==='-S') args.splice(0,2);
  const command=args[0];
  if(s.failCommand===command || (late && s.lateFailCommand===command)) process.exit(1);
  const server=(late?s.lateServer:undefined)??s[phase+'Server']??${JSON.stringify(DEFAULT_SERVER)};
  const navPath=process.env.MOCK_NAVIGATION;
  const nav=fs.existsSync(navPath)?JSON.parse(fs.readFileSync(navPath,'utf8')):{sessions:{},windows:{},panes:{}};
  const arg=(flag)=>args[args.indexOf(flag)+1];
  if(command==='list-panes') process.stdout.write((late?s.latePanes:undefined)??s[phase+'Panes']??DEFAULT_PANES);
  if(command==='list-clients') {
    const rows=(late?s.lateClients:undefined)??s[phase+'Clients']??DEFAULT_CLIENTS;
    for(const row of rows.split('\\n').filter(Boolean)) {
      let [tty,pid,session,pane,window]=row.split('|');
      if(nav.sessions[tty]) {
        session=nav.sessions[tty];
        pane=session==='$1'?'%8':'%9';
        window=undefined;
      }
      window=nav.windows[session]??window??(pane==='%7'?'@4':session==='$1'?'@3':'@5');
      pane=nav.panes[window]??pane;
      console.log([tty,pid,session,pane,window,server,'0'].join('|'));
    }
  }
  if(command==='display-message') console.log(args.at(-1).includes('socket_path')?server+'|'+${JSON.stringify(MOCK_SOCKET)}:server);
  if(command==='switch-client') {
    nav.sessions[arg('-c')]=arg('-t');
    if(s.lateOn==='switch-client') fs.writeFileSync(process.env.MOCK_LATE_STATE,'yes');
  }
  if(command==='select-window') {
    const [session,window]=arg('-t').split(':');
    nav.windows[session]=window;
  }
  if(command==='select-pane') {
    const [,window,pane]=arg('-t').split(/[:.]/);
    nav.panes[window]=pane;
  }
  fs.writeFileSync(navPath,JSON.stringify(nav));
} else if(cmd==='gdbus') {
  if(s.lateOn==='gdbus') fs.writeFileSync(process.env.MOCK_LATE_STATE,'yes');
  const suffix=args[args.length-1];
  const entry=s.dbus?s.dbus[suffix]:undefined;
  if(entry&&typeof entry==='object'){ if(entry.err) process.stderr.write(entry.err); process.stdout.write(entry.out??''); process.exit(entry.exit??0); }
  process.stdout.write(typeof entry==='string'?entry:(s.dbusDefault??'(true,)'));process.exit(0);
} else if(cmd==='wslpath') {
  process.stdout.write('C:\\\\pi\\n');
}
`;
  for (const command of ["tmux", "gdbus", "python3", "notify-send", "xsetroot", "xdotool", "wmctrl", "powershell.exe", "wslpath"]) {
    const path = join(dir, command);
    writeFileSync(path, mock);
    chmodSync(path, 0o755);
  }
  // Backend scenarios must not depend on the host kernel being Linux or WSL.
  const result = spawnSync("bash", ["-c", 'source "$1"; is_wsl() { [[ -n "${WSL_DISTRO_NAME:-}" ]]; }; play_linux_sound() { :; }; main', "bash", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:/usr/bin:/bin`,
      MOCK_DATA: data,
      MOCK_LOG: log,
      MOCK_STATE: state,
      MOCK_LATE_STATE: join(dir, "late"),
      MOCK_NAVIGATION: join(dir, "navigation.json"),
      PI_NOTIFY_WINDOW_ID: "",
      WINDOWID: "",
      WINDOW_ID: "",
      PI_NOTIFY_SESSION_TYPE: "wayland",
      PI_NOTIFY_CURRENT_DESKTOP: "GNOME",
      PI_NOTIFY_TMUX_PANE: SOURCE_PANE,
      PI_NOTIFY_ACTION_TIMEOUT_SEC: "3",
      PI_NOTIFY_KIND: "",
      PI_NOTIFY_PROJECT: "",
      PI_NOTIFY_SESSION_TITLE: "",
      TMUX_PANE: "",
      TMUX: "",
      WAYLAND_DISPLAY: "",
      DISPLAY: "",
      XDG_SESSION_TYPE: "",
      XDG_CURRENT_DESKTOP: "",
      DESKTOP_SESSION: "",
      ALACRITTY_WINDOW_ID: "stale",
      WSL_DISTRO_NAME: "",
      ...env,
    },
    timeout: 15_000,
  });
  const calls: string[][] = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { result, calls };
}

function of(calls: string[][], command: string) {
  return calls.filter((call) => call[0] === command);
}
function suffixes(calls: string[][]) {
  return of(calls, "gdbus").map((call) => call.at(-1));
}
function actionHelper(calls: string[][]) {
  return of(calls, "python3").find((call) => call[1]?.endsWith("notify-action.py"));
}
function mutations(calls: string[][]) {
  return of(calls, "tmux").filter((call) => ["switch-client", "select-window", "select-pane"].includes(call[1]!));
}
function tmux(calls: string[][], subcommand: string) {
  return calls.filter((call) => call[0] === "tmux" && call[1] === subcommand);
}
function suffixFor(pid: number, server = Number(DEFAULT_SERVER)) {
  return `[pi-tmux:${server}:${pid}]`;
}

describe("GNOME Wayland notification focus", () => {
  it("takes the original client back after it changes session before the click", () => {
    // By click time another client is on $1. The captured client still wins and all
    // three mutations happen in order after the first window activation request.
    const { result, calls } = run({ action: "default", afterClients: CROSS_SESSION_CLIENTS });
    expect(result.status, result.stderr).toBe(0);
    const action = actionHelper(calls);
    expect(action?.slice(3)).toEqual(["Pi - Event", "untitled", "3"]);
    expect(calls.indexOf(action!)).toBeLessThan(calls.findIndex((call) => call[0] === "gdbus"));
    expect(suffixes(calls)).toEqual([suffixFor(201), suffixFor(201)]);
    expect(mutations(calls)).toEqual([
      ["tmux", "switch-client", "-c", "/dev/pts/10", "-t", "$1"],
      ["tmux", "select-window", "-t", "$1:@4"],
      ["tmux", "select-pane", "-t", "$1:@4.%7"],
    ]);
  });

  it("activates the terminal without tmux mutations when it already displays the source", () => {
    const { result, calls } = run({ action: "default", afterClients: "/dev/pts/10|201|$1|%7\n" });
    expect(result.status, result.stderr).toBe(0);
    expect(suffixes(calls)).toEqual([suffixFor(201), suffixFor(201)]);
    expect(mutations(calls)).toEqual([]);
  });

  it("activates nothing and switches nobody when the notification is dismissed", () => {
    // Dismissal must not run any desktop or tmux side effect, even with valid candidates.
    const { result, calls } = run({ action: "" });
    expect(result.status).toBe(0);
    expect(suffixes(calls)).toHaveLength(0);
    expect(tmux(calls, "switch-client")).toHaveLength(0);
    expect(tmux(calls, "select-window")).toHaveLength(0);
    expect(tmux(calls, "select-pane")).toHaveLength(0);
  });

  it("skips a lower-PID SSH candidate that has no local window and keeps its session", () => {
    // The SSH client views the source pane (priority 0) with a lower PID, so without the
    // activation proof it would win. It reports (false,) and must be skipped, not switched.
    const ssh = "/dev/pts/20|150|$1|%7\n";
    const local = "/dev/pts/10|201|$1|%8\n";
    const { result, calls } = run({
      action: "default",
      beforeClients: ssh + local,
      afterClients: ssh + local,
      dbus: { [suffixFor(150)]: "(false,)" },
    });
    expect(result.status).toBe(0);
    expect(suffixes(calls)).toEqual([suffixFor(150), suffixFor(201), suffixFor(201)]);
    // The local client already belongs to the source session.
    expect(tmux(calls, "switch-client")).toEqual([]);
  });

  it("orders candidates by priority, then numeric PID regardless of enumeration order", () => {
    // Priority 0 (source-pane viewer 500) beats priority 1; among the priority 1 clients
    // PID 111 must win over 999 even though 999 is enumerated first.
    const rows = "/dev/pts/12|999|$1|%8\n/dev/pts/13|111|$1|%9\n/dev/pts/20|500|$1|%7\n";
    const { result, calls } = run({
      action: "default",
      beforeClients: rows,
      afterClients: rows,
      dbus: { [suffixFor(500)]: "(false,)" },
    });
    expect(result.status).toBe(0);
    expect(suffixes(calls)).toEqual([suffixFor(500), suffixFor(111), suffixFor(111)]);
    expect(tmux(calls, "switch-client")).toEqual([]);

    // Reversing the enumeration must not change the deterministic choice.
    const reversed = "/dev/pts/20|500|$1|%7\n/dev/pts/13|111|$1|%9\n/dev/pts/12|999|$1|%8\n";
    const again = run({
      action: "default",
      beforeClients: reversed,
      afterClients: reversed,
      dbus: { [suffixFor(500)]: "(false,)" },
    });
    expect(suffixes(again.calls)).toEqual([suffixFor(500), suffixFor(111), suffixFor(111)]);
  });

  it("falls back to another server client when the source session is detached", () => {
    // Only a client of $2 is attached; it may be switched back to the captured $1.
    const clients = "/dev/pts/11|202|$2|%9\n";
    const { result, calls } = run({ action: "default", beforeClients: clients, afterClients: clients });
    expect(result.status).toBe(0);
    expect(actionHelper(calls)).toBeDefined();
    expect(suffixes(calls)).toEqual([suffixFor(202), suffixFor(202)]);
    expect(tmux(calls, "switch-client")).toEqual([["tmux", "switch-client", "-c", "/dev/pts/11", "-t", "$1"]]);
    expect(tmux(calls, "select-pane")).toEqual([["tmux", "select-pane", "-t", "$1:@4.%7"]]);
  });

  it("falls back to a local client in another session when source clients have no window", () => {
    // A source session attached only over SSH must not hide a usable local session.
    const { result, calls } = run({ action: "default", dbus: { [suffixFor(201)]: "(false,)" } });
    expect(result.status).toBe(0);
    expect(suffixes(calls)).toEqual([suffixFor(201), suffixFor(202), suffixFor(202)]);
    expect(tmux(calls, "switch-client")).toEqual([["tmux", "switch-client", "-c", "/dev/pts/11", "-t", "$1"]]);
  });

  it("aborts when querying clients fails during the candidate walk", () => {
    // A query failure is not evidence that the client disappeared.
    const { result, calls } = run({
      action: "default", lateOn: "gdbus", lateFailCommand: "list-clients",
      dbus: { [suffixFor(201)]: "(false,)" },
    });
    expect(result.status).not.toBe(0);
    expect(suffixes(calls)).toEqual([suffixFor(201)]);
    expect(result.stderr).toContain("tmux client query failed");
    expect(tmux(calls, "switch-client")).toHaveLength(0);
  });

  it.each([
    ["no clients are attached", ""],
    ["several clients are attached but none is in the source session", "/dev/pts/11|202|$2|%9\n/dev/pts/12|203|$2|%9\n"],
  ])("offers no action when %s", (_name, beforeClients) => {
    // An empty server or an ambiguous fallback must not switch an unrelated terminal.
    const { result, calls } = run({ action: "default", beforeClients });
    expect(result.status).toBe(0);
    expect(actionHelper(calls)).toBeUndefined();
    expect(of(calls, "notify-send")[0]).not.toContain("-A");
    expect(suffixes(calls)).toEqual([]);
    expect(mutations(calls)).toEqual([]);
  });

  it("never considers clients attached after the notification was created", () => {
    // The frozen candidate list contains only the windowless client 202. A local client
    // that attaches later (303) must not be adopted, so the click still fails.
    const late = "/dev/pts/11|202|$2|%9\n/dev/pts/99|303|$1|%8\n";
    const { result, calls } = run({
      action: "default",
      beforeClients: "/dev/pts/11|202|$2|%9\n",
      afterClients: late,
      dbus: { [suffixFor(202)]: "(false,)" },
    });
    expect(result.status).not.toBe(0);
    expect(suffixes(calls)).toEqual([suffixFor(202), suffixFor(202), suffixFor(202)]);
    expect(tmux(calls, "switch-client")).toHaveLength(0);
  });

  it("skips a captured client that disappeared and uses the next captured candidate", () => {
    // Candidate 201 is gone; 202 still exists and activates, so it is switched instead.
    const { result, calls } = run({
      action: "default",
      afterClients: "/dev/pts/11|202|$2|%9\n",
    });
    expect(result.status).toBe(0);
    expect(suffixes(calls)).toEqual([suffixFor(202), suffixFor(202)]);
    expect(tmux(calls, "switch-client")).toEqual([["tmux", "switch-client", "-c", "/dev/pts/11", "-t", "$1"]]);
  });

  it("fails without switching when no captured candidate with a local window remains", () => {
    // Neither the all-false reply nor the missing last client may be reported as success.
    const only = "/dev/pts/20|150|$1|%7\n";
    const noWindow = run({ action: "default", beforeClients: only, afterClients: only, dbus: { [suffixFor(150)]: "(false,)" } });
    expect(noWindow.result.status).not.toBe(0);
    expect(suffixes(noWindow.calls)).toEqual([suffixFor(150), suffixFor(150), suffixFor(150)]);
    expect(tmux(noWindow.calls, "switch-client")).toHaveLength(0);
    expect(noWindow.result.stderr).toContain("no local window matched");

    const gone = run({ action: "default", afterClients: "" });
    expect(gone.result.status).not.toBe(0);
    expect(suffixes(gone.calls)).toHaveLength(0);
    expect(tmux(gone.calls, "switch-client")).toHaveLength(0);
    expect(gone.result.stderr).toContain("disappeared before activation");
  });

  it.each([
    ["transport error", { out: "", exit: 1 }],
    ["timeout", { out: "", exit: 124 }],
    ["unexpected reply", { out: "(bogus,)\n", exit: 0 }],
  ] as Array<[string, DbusResult]>)("aborts on a %s instead of walking every candidate", (_label, reply) => {
    // A broken extension/gdbus must not be retried across the whole candidate list.
    const { result, calls } = run({
      action: "default",
      dbus: { [suffixFor(201)]: reply },
    });
    expect(result.status).not.toBe(0);
    expect(suffixes(calls)).toHaveLength(1);
    expect(tmux(calls, "switch-client")).toHaveLength(0);
    expect(tmux(calls, "select-pane")).toHaveLength(0);
    expect(result.stderr).toContain("D-Bus activation error");
  });

  it("does not switch a client that vanishes right after its window activates", () => {
    // Activation proves the window exists, but the client must still be attached before
    // the tmux switch; otherwise the captured client is stale.
    const { result, calls } = run({
      action: "default",
      lateOn: "gdbus",
      lateClients: "/dev/pts/11|202|$2|%9\n",
    });
    expect(result.status).not.toBe(0);
    expect(suffixes(calls)).toEqual([suffixFor(201)]);
    expect(tmux(calls, "switch-client")).toHaveLength(0);
  });

  it("stops after the chosen client disappears during the jump", () => {
    // Another client is now on the source session, but cannot replace the chosen client.
    const { result, calls } = run({
      action: "default", afterClients: CROSS_SESSION_CLIENTS,
      lateOn: "switch-client", lateClients: "/dev/pts/11|202|$1|%8\n",
    });
    expect(result.status).not.toBe(0);
    expect(suffixes(calls)).toEqual([suffixFor(201)]);
    expect(mutations(calls).map((call) => call[1])).toEqual(["switch-client"]);
    expect(result.stderr).toContain("the selected client disappeared");
  });

  it("skips a client that vanished after a false probe and never retries its suffix", () => {
    // Candidate 201 answers (false,) and then disconnects; its suffix must not be probed
    // again, and the walk must move on to the still-attached 202.
    const { result, calls } = run({
      action: "default",
      lateOn: "gdbus",
      lateClients: "/dev/pts/11|202|$2|%9\n",
      dbus: { [suffixFor(201)]: "(false,)" },
    });
    expect(result.status).toBe(0);
    expect(suffixes(calls).filter((suffix) => suffix === suffixFor(201))).toHaveLength(1);
    expect(suffixes(calls)).toEqual([suffixFor(201), suffixFor(202), suffixFor(202)]);
    expect(tmux(calls, "switch-client")).toEqual([["tmux", "switch-client", "-c", "/dev/pts/11", "-t", "$1"]]);
  });

  it.each([
    ["server replaced", { lateServer: "999" }, "tmux server changed since the notification"],
    ["source pane gone", { latePanes: "%8|$1|@4\n" }, "source pane/session changed since the notification"],
  ] as Array<[string, Scenario, string]>)("aborts the walk once %s during a false probe", (_label, changes, message) => {
    // A source that changes during the candidate walk must stop the click; the next
    // candidate must not be activated against the changed server/source.
    const { result, calls } = run({
      action: "default",
      lateOn: "gdbus",
      dbus: { [suffixFor(201)]: "(false,)" },
      ...changes,
    });
    expect(result.status).not.toBe(0);
    expect(suffixes(calls)).toEqual([suffixFor(201)]);
    expect(tmux(calls, "switch-client")).toHaveLength(0);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain("no local window matched");
  });

  it("stops after the server is replaced following the switch", () => {
    const { result, calls } = run({
      action: "default", afterClients: CROSS_SESSION_CLIENTS, lateOn: "switch-client", lateServer: "999",
    });
    expect(result.status).not.toBe(0);
    expect(suffixes(calls)).toEqual([suffixFor(201)]);
    expect(mutations(calls).map((call) => call[1])).toEqual(["switch-client"]);
    expect(result.stderr).toContain("tmux server changed since the notification");
  });

  it("preserves the underlying gdbus error text in its diagnostic", () => {
    // Transport failures keep the extension/D-Bus message instead of a generic claim.
    const err = "GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: no extension\n";
    const { result } = run({ action: "default", dbus: { [suffixFor(201)]: { out: "", exit: 1, err } } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("D-Bus activation error");
    expect(result.stderr).toContain("ServiceUnknown");
  });

  it("re-resolves the window ID at click time instead of trusting a stale one", () => {
    // The pane moved to window @12 within its session, so the switch must target @12.
    const { result, calls } = run({ action: "default", afterPanes: "%7|$1|@12\n" });
    expect(result.status).toBe(0);
    expect(tmux(calls, "select-window")).toEqual([["tmux", "select-window", "-t", "$1:@12"]]);
    expect(tmux(calls, "select-pane")).toEqual([["tmux", "select-pane", "-t", "$1:@12.%7"]]);
  });

  it.each([
    ["deleted pane", { afterPanes: "%8|$1|@4\n" }],
    ["pane moved to another session", { afterPanes: "%7|$2|@4\n" }],
    ["linked pane at click", { afterPanes: "%7|$1|@4\n%7|$2|@4\n" }],
    ["new tmux server", { afterServer: "999" }],
    ["same tty reused by another PID", { afterClients: "/dev/pts/10|999|$1|%8\n" }],
  ])("fails closed on a stale click target: %s", (_label, scenario) => {
    // Server, source pane/session and client tty+PID are revalidated before any D-Bus or
    // tmux side effect, so stale identities fail without a guess.
    const { result, calls } = run({ action: "default", ...scenario });
    expect(result.status).not.toBe(0);
    expect(suffixes(calls)).toHaveLength(0);
    expect(tmux(calls, "switch-client")).toHaveLength(0);
  });

  it.each([["switch-client"], ["select-window"], ["select-pane"]])(
    "reports failure when tmux %s fails after activation",
    (command) => {
      const { result, calls } = run({ action: "default", afterClients: CROSS_SESSION_CLIENTS, failCommand: command });
      expect(result.status).not.toBe(0);
      expect(suffixes(calls)).toEqual([suffixFor(201)]);
      expect(result.stderr).toContain(`tmux ${command} failed`);
      expect(result.stderr).not.toContain("no local window matched");
    },
  );

  it.each([
    ["no pane", { PI_NOTIFY_TMUX_PANE: "" }],
    ["linked source pane", {}],
    ["tmux query failure", {}],
    ["client query failure", {}],
    ["server query failure", {}],
    ["only malformed client rows", {}],
  ])("sends a plain notification without a focus action for %s", (label, env) => {
    // No trustworthy candidate list means no action is offered at all.
    const scenario: Scenario = { action: "default" };
    if (label === "linked source pane") scenario.beforePanes = "%7|$1|@4\n%7|$2|@4\n";
    if (label === "tmux query failure") scenario.failCommand = "list-panes";
    if (label === "client query failure") scenario.failCommand = "list-clients";
    if (label === "server query failure") scenario.failCommand = "display-message";
    if (label === "only malformed client rows") scenario.beforeClients = "garbage\n/dev/pts/10|abc|$1|%8\n";
    const { result, calls } = run(scenario, env);
    expect(result.status).toBe(0);
    expect(actionHelper(calls)).toBeUndefined();
    expect(of(calls, "notify-send")[0]).not.toContain("-A");
    expect(tmux(calls, "switch-client")).toHaveLength(0);
  });

  it("shows a plain notification for non-tmux GNOME even with a stale Alacritty ID", () => {
    const { result, calls } = run({ action: "default" }, { PI_NOTIFY_TMUX_PANE: "" });
    expect(result.status).toBe(0);
    expect(actionHelper(calls)).toBeUndefined();
    expect(of(calls, "notify-send")).toHaveLength(1);
    expect(of(calls, "tmux")).toHaveLength(0);
    expect(of(calls, "gdbus")).toHaveLength(0);
  });

  it("keeps the X11 Jump action working without the Python helper", () => {
    const { result, calls } = run({ action: "jump" }, {
      PI_NOTIFY_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "stale", DISPLAY: ":5", PI_NOTIFY_TMUX_PANE: "",
      PI_NOTIFY_WINDOW_ID: "123",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(of(calls, "notify-send")[0]).toContain("jump=Jump");
    expect(of(calls, "xsetroot")[0]).toEqual(["xsetroot", "-name", "fsignal:switchtoclientwin ul 123"]);
    expect(actionHelper(calls)).toBeUndefined();
    expect(suffixes(calls)).toEqual([]);
  });

  it("passes the stable tmux target and server/client context to the WSL backend", () => {
    const { result, calls } = run({ beforeClients: "/dev/pts/10|201|$1|%7\n" }, { WSL_DISTRO_NAME: "Ubuntu" });
    expect(result.status, result.stderr).toBe(0);
    const command = of(calls, "powershell.exe")[0]!;
    const payload = (name: string) => Buffer.from(command[command.indexOf(name) + 1]!, "base64").toString();
    expect(payload("-TmuxTargetBase64")).toBe("$1:@4.%7");
    expect(payload("-TmuxClientTtyBase64")).toBe("/dev/pts/10");
    expect(payload("-TmuxContextBase64")).toBe(`101|201|${MOCK_SOCKET}`);
    expect(of(calls, "notify-send")).toEqual([]);
    expect(actionHelper(calls)).toBeUndefined();
  });

  it("sends a plain notification if the GNOME helper cannot provide an action", () => {
    const { result, calls } = run({ action: "default", actionUnavailable: true });
    expect(result.status).toBe(0);
    expect(of(calls, "notify-send")[0]).not.toContain("-A");
    expect(suffixes(calls)).toEqual([]);
    expect(mutations(calls)).toEqual([]);
  });

  it("does nothing when sourced without calling main", () => {
    // Unit helpers can source the shell without emitting a desktop notification.
    const dir = mkdtempSync(join(tmpdir(), "pi-source-"));
    dirs.push(dir);
    const result = spawnSync("bash", ["-c", 'source "$1"; declare -F perform_gnome_jump resolve_gnome_context', "bash", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
      timeout: 3_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("perform_gnome_jump");
    expect(result.stdout).toContain("resolve_gnome_context");
  });
});
