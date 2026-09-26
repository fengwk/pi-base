#!/usr/bin/env python3
"""Opt-in desktop smoke test: opens two Alacritty windows and changes focus.

Requires a running Alacritty IPC socket, tmux, and Activate Window By Title.
Only an isolated tmux server is created/destroyed. Existing sessions are untouched.
Focus is verified via terminal focus-in/out reports, not the D-Bus return value.
This tests the click callback, not physical notification clicking or monitor layout.
"""

import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import time


def run(*args, env=None, check=True):
    return subprocess.run(
        args, env=env, check=check, capture_output=True, text=True, timeout=15
    ).stdout.strip()


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
    script = Path(__file__).with_name("notify.sh")
    with tempfile.TemporaryDirectory(prefix="pi-gnome-focus-") as directory:
        socket = str(Path(directory) / "tmux.sock")

        def tmux(*arguments, check=True):
            return run("tmux", "-S", socket, *arguments, check=check)

        def clients():
            rows = tmux("list-clients", "-F", "#{session_name}|#{client_pid}|#{client_flags}")
            return {
                name: (pid, set(flags.split(",")))
                for name, pid, flags in (row.split("|") for row in rows.splitlines())
            }

        try:
            tmux("-f", "/dev/null", "new-session", "-d", "-s", "pi-focus-A", "sleep 120")
            tmux("new-session", "-d", "-s", "pi-focus-B", "sleep 120")
            tmux("set-option", "-s", "focus-events", "on")
            tmux("set-option", "-g", "set-titles", "on")
            tmux("set-option", "-g", "set-titles-string",
                 "#S:#I:#W [pi-tmux:#{pid}:#{client_pid}]")
            server = tmux("display-message", "-p", "#{pid}")
            targets = {}
            for name in ("pi-focus-A", "pi-focus-B"):
                # The notification source is initially not the visible active pane.
                targets[name] = tmux("split-window", "-d", "-t", name,
                                     "-P", "-F", "#{pane_id}", "sleep 120")
                # Same Alacritty process, distinct windows/clients: PID-only lookup cannot work.
                run("alacritty", "msg", "create-window", "-o", "window.dynamic_title=true",
                    "-e", "tmux", "-S", socket, "attach-session", "-t", name)
            wait_for(lambda: len(clients()) == 2, "two test clients did not attach")
            for name in ("pi-focus-A", "pi-focus-B", "pi-focus-A"):
                # Exercise the production source resolver and click callback with real tmux/D-Bus.
                env = dict(os.environ, TMUX=f"{socket},{server},0",
                           TMUX_PANE=targets[name], PI_NOTIFY_TMUX_PANE=targets[name])
                run("bash", "-c",
                    'source "$1"; resolve_gnome_context; perform_gnome_jump',
                    "bash", str(script), env=env)

                def focused():
                    state = clients()
                    return all(
                        ("focused" in flags) == (client == name)
                        for client, (_, flags) in state.items()
                    ) and len(state) == 2

                wait_for(focused, f"terminal focus reports did not select only {name}")
                assert tmux("display-message", "-p", "-t", name, "#{pane_id}") == targets[name]
                print(f"PASS: {name} alone reports focus; pane={targets[name]}", flush=True)
            print("PASS: real callback, unique titles, same-process two-window focus")
        finally:
            # Killing this isolated server closes only the two test windows.
            tmux("kill-server", check=False)


if __name__ == "__main__":
    main()
