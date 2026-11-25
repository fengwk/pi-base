import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const helper = resolve("scripts/notify-action.py");
const hasIsolatedBus = spawnSync("dbus-run-session", ["--", "python3", "-c", "from gi.repository import Gio, GLib"], {
  timeout: 3_000,
}).status === 0;

// Use a private D-Bus bus, not the desktop. The fake service sends signals directly to
// the connection that called Notify, so a one-shot sender plus a separate listener fails.
const driver = `
import subprocess, sys, warnings
from gi.repository import Gio, GLib

warnings.filterwarnings("ignore", "Gio.DBusConnection.register_object is deprecated", DeprecationWarning)

helper, scenario = sys.argv[1:]
service = "org.freedesktop.Notifications"
path = "/org/freedesktop/Notifications"
interface = Gio.DBusNodeInfo.new_for_xml('''<node>
  <interface name="org.freedesktop.Notifications">
    <method name="GetCapabilities"><arg type="as" direction="out"/></method>
    <method name="Notify">
      <arg type="s" direction="in"/><arg type="u" direction="in"/>
      <arg type="s" direction="in"/><arg type="s" direction="in"/>
      <arg type="s" direction="in"/><arg type="as" direction="in"/>
      <arg type="a{sv}" direction="in"/><arg type="i" direction="in"/>
      <arg type="u" direction="out"/>
    </method>
  </interface>
</node>''').interfaces[0]
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()

def on_call(connection, sender, _path, _interface, method, params, invocation):
    if method == "GetCapabilities":
        capabilities = [] if scenario == "unsupported" else ["actions"]
        invocation.return_value(GLib.Variant("(as)", (capabilities,)))
        return
    app, _replaces, icon, title, body, actions, _hints, _timeout = params.unpack()
    assert (app, icon, title, body, actions) == ("Pi", "icon", "title", "body", ["default", "切回并聚焦"])
    invocation.return_value(GLib.Variant("(u)", (42,)))
    if scenario == "timeout":
        return
    if scenario == "click":
        connection.emit_signal(sender, path, service, "ActionInvoked", GLib.Variant("(us)", (42, "default")))
    else:
        connection.emit_signal(sender, path, service, "ActionInvoked", GLib.Variant("(us)", (41, "default")))
    connection.emit_signal(sender, path, service, "NotificationClosed", GLib.Variant("(uu)", (42, 2)))

bus.register_object(path, interface, on_call, None, None)
bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
              GLib.Variant("(su)", (service, 0)), None, Gio.DBusCallFlags.NONE, 1000, None)
process = subprocess.Popen([sys.executable, helper, "icon", "title", "body", "1" if scenario == "timeout" else "6"])

def poll():
    if process.poll() is None:
        return True
    loop.quit()
    return False

GLib.timeout_add(25, poll)
GLib.timeout_add(4000, loop.quit)
loop.run()
if process.poll() is None:
    process.kill()
    process.wait()
    sys.exit("notification helper did not exit after the signal")
sys.exit(process.returncode)
`;

describe.skipIf(!hasIsolatedBus)("GNOME notification action helper", () => {
  function run(scenario: string) {
    return spawnSync("dbus-run-session", ["--", "python3", "-c", driver, helper, scenario], {
      encoding: "utf8",
      timeout: 8_000,
    });
  }

  it("receives a default action addressed to the notification sender before closing", () => {
    const result = run("click");
    expect(result.status, result.stderr).toBe(0);
  });

  it("exits on close without acting on another notification's click", () => {
    const result = run("close");
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toBe("");
  });

  it("stops waiting when the service sends no signal", () => {
    const result = run("timeout");
    expect(result.status, result.stderr).toBe(3);
  });

  it("reports when the server lacks actions so the shell can send a plain notification", () => {
    const result = run("unsupported");
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("the notification server does not support actions");
  });
});
