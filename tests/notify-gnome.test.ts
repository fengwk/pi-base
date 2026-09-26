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

type Scenario = {
  action?: string;
  beforePanes?: string;
  afterPanes?: string;
  beforeClients?: string;
  afterClients?: string;
  beforeServer?: string;
  afterServer?: string;
  lateClients?: string;
  disconnectAt?: "switch-client" | "gdbus";
  failCommand?: string;
  dbus?: string;
  dbusExit?: number;
};

function run(scenario: Scenario = {}, env: Record<string, string> = {}) {
  // Intent: execute the real shell path, with every desktop/tmux call replaced by a
  // deterministic executable; click toggles the fixture from capture to revalidation.
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  dirs.push(dir);
  const log = join(dir, "calls");
  const state = join(dir, "clicked");
  const data = join(dir, "scenario.json");
  writeFileSync(data, JSON.stringify(scenario));
  const mock = `#!${process.execPath}
const fs=require('node:fs');
const path=require('node:path');
const args=process.argv.slice(2), cmd=path.basename(process.argv[1]);
const s=JSON.parse(fs.readFileSync(process.env.MOCK_DATA,'utf8'));
fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify([cmd,...args])+'\\n');
const after=fs.existsSync(process.env.MOCK_STATE), phase=after?'after':'before';
if(cmd==='notify-send') {
  fs.writeFileSync(process.env.MOCK_STATE,'yes');
  process.stdout.write(s.action||'');
} else if(cmd==='tmux') {
  if(s.failCommand===args[0]) process.exit(1);
  if(args[0]==='list-panes') process.stdout.write(s[phase+'Panes']??'%7|$1|@4\\n');
  if(args[0]==='list-clients') process.stdout.write(
    (fs.existsSync(process.env.MOCK_LATE_STATE) ? s.lateClients : undefined)
    ??s[phase+'Clients']??'/dev/pts/10|201|$1|%8\\n/dev/pts/11|202|$2|%9\\n'
  );
  if(args[0]==='display-message') process.stdout.write((s[phase+'Server']??'101')+'\\n');
  if(args[0]==='switch-client' && s.disconnectAt===args[0]) fs.writeFileSync(process.env.MOCK_LATE_STATE,'yes');
} else if(cmd==='gdbus') {
  if(s.disconnectAt==='gdbus') fs.writeFileSync(process.env.MOCK_LATE_STATE,'yes');
  process.stdout.write(s.dbus??'(true,)\\n');
  process.exit(s.dbusExit??0);
} else if(cmd==='wslpath') {
  process.stdout.write('C:\\\\pi\\n');
}
`;
  for (const command of ["tmux", "gdbus", "notify-send", "xsetroot", "xdotool", "wmctrl", "powershell.exe", "wslpath"]) {
    const path = join(dir, command);
    writeFileSync(path, mock);
    chmodSync(path, 0o755);
  }
  const result = spawnSync("bash", ["-c", 'source "$1"; play_linux_sound() { :; }; main', "bash", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:/usr/bin:/bin`,
      MOCK_DATA: data,
      MOCK_LOG: log,
      MOCK_STATE: state,
      MOCK_LATE_STATE: join(dir, "disconnected"),
      PI_NOTIFY_SESSION_TYPE: "wayland",
      PI_NOTIFY_CURRENT_DESKTOP: "GNOME",
      PI_NOTIFY_TMUX_PANE: "%7",
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
  const calls: string[][] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { result, calls, commands: (name: string) => calls.filter((call) => call[0] === name) };
}

describe("GNOME Wayland notification focus", () => {
  it("freezes the unique session client, selects stable IDs, and activates only its title suffix", () => {
    // The source pane is not the client's current pane; its session has exactly one client.
    const { result, commands } = run({ action: "default", afterPanes: "%7|$1|@12\n" });
    expect(result.status).toBe(0);
    expect(commands("notify-send")[0]).toContain("default=切回并聚焦");
    expect(commands("tmux").filter((c) => c[1] === "switch-client")[0]).toEqual(["tmux", "switch-client", "-c", "/dev/pts/10", "-t", "$1"]);
    expect(commands("tmux").filter((c) => c[1] === "select-window")[0]).toEqual(["tmux", "select-window", "-t", "$1:@12"]);
    expect(commands("tmux").filter((c) => c[1] === "select-pane")[0]).toEqual(["tmux", "select-pane", "-t", "$1:@12.%7"]);
    expect(commands("gdbus")[0]).toEqual(["gdbus", "call", "--session", "--timeout", "2", "--dest", "org.gnome.Shell",
      "--object-path", "/de/lucaswerkmeister/ActivateWindowByTitle",
      "--method", "de.lucaswerkmeister.ActivateWindowByTitle.activateBySuffix", "--", "[pi-tmux:101:201]"]);
  });

  it("does not jump on dismissal and prefers the sole active-pane client", () => {
    // Another client in the same session must not override a unique active pane match.
    const clients = "/dev/pts/10|201|$1|%7\n/dev/pts/12|203|$1|%8\n/dev/pts/11|202|$2|%9\n";
    const dismissed = run({ beforeClients: clients });
    expect(dismissed.result.status).toBe(0);
    expect(dismissed.commands("tmux").some((c) => c[1] === "switch-client")).toBe(false);
    expect(dismissed.commands("gdbus")).toHaveLength(0);
    const clicked = run({ beforeClients: clients, afterClients: clients, action: "default" });
    expect(clicked.result.status).toBe(0);
    expect(clicked.commands("gdbus")[0].at(-1)).toBe("[pi-tmux:101:201]");
  });

  it("uses the sole attached server client when the source session is detached", () => {
    // Switching away from a task session detaches it; one server-wide client is
    // deterministic, so the action must switch it back to the captured source.
    const clients = "/dev/pts/11|202|$2|%9\n";
    const { result, commands } = run({ action: "default", beforeClients: clients, afterClients: clients });
    expect(result.status).toBe(0);
    expect(commands("notify-send")[0]).toContain("default=切回并聚焦");
    expect(commands("tmux").filter((c) => c[1] === "switch-client")[0])
      .toEqual(["tmux", "switch-client", "-c", "/dev/pts/11", "-t", "$1"]);
    expect(commands("tmux").filter((c) => c[1] === "select-pane")[0])
      .toEqual(["tmux", "select-pane", "-t", "$1:@4.%7"]);
    expect(commands("gdbus")[0].at(-1)).toBe("[pi-tmux:101:202]");
  });

  it.each([
    ["no pane", { beforePanes: "%8|$1|@4\n" }],
    ["linked sessions", { beforePanes: "%7|$1|@4\n%7|$2|@4\n" }],
    ["ambiguous active clients", { beforeClients: "/dev/pts/10|201|$1|%7\n/dev/pts/12|203|$1|%7\n" }],
    ["ambiguous session clients", { beforeClients: "/dev/pts/10|201|$1|%8\n/dev/pts/12|203|$1|%9\n" }],
    ["detached source with multiple server clients", { beforeClients: "/dev/pts/11|202|$2|%9\n/dev/pts/12|203|$3|%10\n" }],
    ["no attached client", { beforeClients: "" }],
    ["tmux query failure", { failCommand: "list-panes" }],
    ["client query failure", { failCommand: "list-clients" }],
    ["server query failure", { failCommand: "display-message" }],
  ])("fails closed on %s", (_label, scenario) => {
    // Ambiguity and query errors yield a plain notification, never a guessed focus action.
    const { result, commands } = run({ ...scenario, action: "default" });
    expect(result.status).toBe(0);
    expect(commands("notify-send")[0]).not.toContain("default=切回并聚焦");
    expect(commands("gdbus")).toHaveLength(0);
  });

  it.each([
    ["deleted pane", { afterPanes: "%8|$1|@4\n" }],
    ["moved pane", { afterPanes: "%7|$2|@4\n" }],
    ["deleted client", { afterClients: "/dev/pts/11|202|$2|%9\n" }],
    ["reused tty", { afterClients: "/dev/pts/10|999|$1|%8\n" }],
    ["new server", { afterServer: "999" }],
    ["switch failure", { failCommand: "switch-client" }],
    ["window failure", { failCommand: "select-window" }],
    ["pane failure", { failCommand: "select-pane" }],
  ])("rejects stale target or tmux failure: %s", (_label, scenario) => {
    // A click must report failure instead of claiming that the original target was focused.
    const { result, commands } = run({ action: "default", ...scenario });
    expect(result.status).not.toBe(0);
    expect(commands("gdbus")).toHaveLength(0);
  });

  it("does not activate a terminal when its client disconnects after tmux switching", () => {
    // Click-time validation is insufficient: the client must still exist after
    // tmux side effects and immediately before the D-Bus call.
    const { result, commands } = run({
      action: "default",
      disconnectAt: "switch-client",
      lateClients: "/dev/pts/11|202|$2|%9\n",
    });
    expect(result.status).not.toBe(0);
    expect(commands("tmux").some((c) => c[1] === "select-pane")).toBe(true);
    expect(commands("gdbus")).toHaveLength(0);
  });

  it("stops retrying D-Bus activation if the client disappears after the first lookup", () => {
    // Never reuse a stale titled terminal once the captured client has gone away.
    const { result, commands } = run({
      action: "default",
      dbus: "(false,)\n",
      disconnectAt: "gdbus",
      lateClients: "/dev/pts/11|202|$2|%9\n",
    });
    expect(result.status).not.toBe(0);
    expect(commands("gdbus")).toHaveLength(1);
  });

  it.each([{ dbus: "(false,)\n" }, { dbus: "", dbusExit: 1 }, { dbus: "", dbusExit: 124 }])("does not claim focus for missing/failed activation: %j", (scenario) => {
    // The bounded method call alone is not evidence of a matching title.
    const { result, commands } = run({ action: "default", ...scenario });
    expect(result.status).not.toBe(0);
    expect(commands("gdbus")).toHaveLength(3);
    expect(commands("tmux").some((c) => c.includes("select-pane"))).toBe(true);
    expect(commands("xsetroot")).toHaveLength(0);
    expect(commands("xdotool")).toHaveLength(0);
    expect(commands("wmctrl")).toHaveLength(0);
  });

  it("shows a plain notification for non-tmux GNOME even with a stale Alacritty ID", () => {
    const { result, commands } = run({ action: "default" }, { PI_NOTIFY_TMUX_PANE: "" });
    expect(result.status).toBe(0);
    expect(commands("notify-send")[0]).not.toContain("default=切回并聚焦");
    expect(commands("tmux")).toHaveLength(0);
    expect(commands("gdbus")).toHaveLength(0);
  });

  it("leaves the X11 notification action and window activation available", () => {
    // X11 keeps its preexisting Jump action rather than entering the GNOME D-Bus path.
    const { commands } = run({ action: "jump" }, {
      PI_NOTIFY_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "stale", DISPLAY: ":5", PI_NOTIFY_TMUX_PANE: "",
      PI_NOTIFY_WINDOW_ID: "123",
    });
    expect(commands("notify-send")[0]).toContain("jump=Jump");
    expect(commands("xsetroot")[0]).toEqual(["xsetroot", "-name", "fsignal:switchtoclientwin ul 123"]);
    expect(commands("gdbus")).toHaveLength(0);
  });

  it("preserves the WSL PowerShell backend instead of sending GNOME notifications", () => {
    // WSL backend selection takes precedence when the Windows helper is available.
    const { result, commands } = run({}, { WSL_DISTRO_NAME: "Ubuntu", PI_NOTIFY_SESSION_TYPE: "wayland" });
    expect(result.status).toBe(0);
    expect(commands("powershell.exe")[0]).toContain("-TitleBase64");
    expect(commands("notify-send")).toHaveLength(0);
    expect(commands("gdbus")).toHaveLength(0);
  });

  it("does nothing when sourced without calling main", () => {
    // Unit helpers can source the shell without emitting a desktop notification.
    const dir = mkdtempSync(join(tmpdir(), "pi-source-"));
    dirs.push(dir);
    const result = spawnSync("bash", ["-c", 'source "$1"; declare -F perform_gnome_jump', "bash", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
      timeout: 3_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("perform_gnome_jump");
  });
});
