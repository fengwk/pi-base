#!/usr/bin/env python3
"""Wait for a GNOME notification click on the D-Bus connection that sent it.

Exit 0 on the default action, 2 if actions are unavailable, 3 on close/timeout.
"""

import sys


SERVICE = "org.freedesktop.Notifications"
OBJECT_PATH = "/org/freedesktop/Notifications"
DEFAULT_TIMEOUT = 600


def unavailable(reason):
    print(f"Pi notify: GNOME notification actions unavailable: {reason}", file=sys.stderr)
    return 2


def main(argv):
    if len(argv) != 4:
        return unavailable("expected icon, title, body and timeout")
    icon, title, body, timeout_text = argv
    try:
        timeout = int(timeout_text)
    except ValueError:
        timeout = DEFAULT_TIMEOUT
    if not 0 < timeout <= 2**31 - 1:
        timeout = DEFAULT_TIMEOUT

    try:
        from gi.repository import Gio, GLib
    except ImportError:
        return unavailable("install PyGObject (python3-gi on Ubuntu)")

    try:
        proxy = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            None, SERVICE, OBJECT_PATH, SERVICE, None,
        )
        capabilities, = proxy.call_sync(
            "GetCapabilities", None, Gio.DBusCallFlags.NONE, 2000, None,
        ).unpack()
        if "actions" not in capabilities:
            return unavailable("the notification server does not support actions")

        loop = GLib.MainLoop()
        notification_id = None
        clicked = False

        def on_signal(_proxy, _sender, member, parameters):
            nonlocal clicked
            if member == "ActionInvoked" and parameters.unpack() == (notification_id, "default"):
                clicked = True
                loop.quit()
            elif member == "NotificationClosed" and parameters.unpack()[0] == notification_id:
                loop.quit()

        # Subscribe before sending: an early signal is queued until the main loop runs.
        proxy.connect("g-signal", on_signal)
        notification_id, = proxy.call_sync(
            "Notify",
            GLib.Variant("(susssasa{sv}i)", ("Pi", 0, icon, title, body, ["default", "切回并聚焦"], {}, -1)),
            Gio.DBusCallFlags.NONE, 5000, None,
        ).unpack()
    except GLib.Error as error:
        return unavailable(error.message)

    def stop_waiting():
        loop.quit()
        return False

    GLib.timeout_add_seconds(timeout, stop_waiting)
    loop.run()
    return 0 if clicked else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
