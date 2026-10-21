#!/usr/bin/env python3
"""Opt-in desktop smoke test: opens three Alacritty windows and changes focus.

Requires a running Alacritty IPC socket, tmux, and Activate Window By Title.
Only an isolated tmux server is created/destroyed. Existing sessions are untouched.
Two windows share one session so candidate priority and numeric-PID selection can be
observed. Focus is verified via terminal focus-in/out reports, not the D-Bus return value.
This tests the click callback, not physical notification clicking or monitor layout.
"""

import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import time

SESSION_A = "pi-focus-A"
SESSION_B = "pi-focus-B"


def run(*args, env=None, check=True):
    result = subprocess.run(
        args, env=env, check=False, capture_output=True, text=True, timeout=15
    )
    if check and result.returncode:
        raise RuntimeError(f"{args!r} failed ({result.returncode}): {result.stderr.strip()}")
    return result.stdout.strip()


def wait_for(predicate, message):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise AssertionError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="allow temporary windows/focus changes")
    args = parser.parse_args()
    if not args.run:
        parser.error("pass --run to allow temporary windows and focus changes")
    if not os.environ.get("ALACRITTY_SOCKET"):
        parser.error("run from an Alacritty session with ALACRITTY_SOCKET")
    if run("gdbus", "call", "--session", "--dest", "org.gnome.ScreenSaver",
           "--object-path", "/org/gnome/ScreenSaver",
           "--method", "org.gnome.ScreenSaver.GetActive") == "(true,)":
        parser.error("unlock the GNOME desktop before running the focus test")
    script = Path(__file__).with_name("notify.sh")
    with tempfile.TemporaryDirectory(prefix="pi-gnome-focus-") as directory:
        socket = str(Path(directory) / "tmux.sock")

        def tmux(*arguments, check=True):
            return run("tmux", "-S", socket, *arguments, check=check)

        def client_state():
            rows = tmux("list-clients", "-F", "#{session_name}|#{client_pid}|#{client_flags}")
            state = []
            for row in rows.splitlines():
                name, pid, flags = row.split("|")
                state.append((name, int(pid), set(flags.split(","))))
            return state

        def session_pids(name):
            return sorted(pid for session, pid, _flags in client_state() if session == name)

        def focused_pids():
            return {pid for _session, pid, flags in client_state() if "focused" in flags}

        def attach(session):
            # Same Alacritty process, distinct windows/clients: PID-only lookup cannot work.
            run("alacritty", "msg", "create-window", "-o", "window.dynamic_title=true",
                "-e", "tmux", "-S", socket, "attach-session", "-t", session)

        def focus(session, target, expected_pids):
            # Exercise the production source resolver and click callback with real tmux/D-Bus.
            env = dict(os.environ, TMUX=f"{socket},{server},0",
                       TMUX_PANE=target, PI_NOTIFY_TMUX_PANE=target)
            run("bash", "-c",
                'source "$1"; resolve_gnome_context; perform_gnome_jump',
                "bash", str(script), env=env)
            wait_for(lambda: focused_pids() == expected_pids,
                     f"terminal focus reports did not select {sorted(expected_pids)} "
                     f"in {session}: {sorted(focused_pids())}")
            assert tmux("display-message", "-p", "-t", session, "#{pane_id}") == target
            print(f"PASS: {session} focused {sorted(expected_pids)}; pane={target}", flush=True)

        try:
            tmux("-f", "/dev/null", "new-session", "-d", "-s", SESSION_A, "sleep 120")
            tmux("new-session", "-d", "-s", SESSION_B, "sleep 120")
            tmux("set-option", "-s", "focus-events", "on")
            tmux("set-option", "-g", "set-titles", "on")
            tmux("set-option", "-g", "set-titles-string",
                 "#S:#I:#W [pi-tmux:#{pid}:#{client_pid}]")
            server = tmux("display-message", "-p", "#{pid}")
            targets = {}
            for session in (SESSION_A, SESSION_B):
                # The notification source is initially not the visible active pane.
                targets[session] = tmux("split-window", "-d", "-t", session,
                                        "-P", "-F", "#{pane_id}", "sleep 120")
            attach(SESSION_A)
            attach(SESSION_B)
            attach(SESSION_A)
            wait_for(lambda: len(client_state()) == 3, "three test clients did not attach")

            # A has two clients, so numeric PID breaks the tie: only the lowest-PID client
            # may be focused and the other must stay untouched. The repeat run happens after
            # both clients view the source pane, exercising the same tie at a higher priority.
            focus(SESSION_A, targets[SESSION_A], {session_pids(SESSION_A)[0]})
            # B has a single client, which must be the only focused terminal.
            focus(SESSION_B, targets[SESSION_B], {session_pids(SESSION_B)[0]})
            focus(SESSION_A, targets[SESSION_A], {session_pids(SESSION_A)[0]})
            print("PASS: real callback, frozen candidates, priority and numeric-PID selection",
                  flush=True)
        finally:
            # Killing this isolated server closes only the test windows.
            tmux("kill-server", check=False)


if __name__ == "__main__":
    main()
