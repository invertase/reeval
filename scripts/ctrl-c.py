"""Runs a command and presses Ctrl-C on it the way a terminal does, then exits with its code.

    python scripts/ctrl-c.py <glob> <command> [args…]

Once a file matching <glob> (relative to the working directory) exists, it sends Ctrl-C: SIGINT
to the command's process group on POSIX, and a CTRL_C_EVENT on the command's own console on
Windows, which reaches every process in it as a keypress would. The command's output is copied
to stdout. binary-python-smoke.mjs uses it to stop a run through reeval-python's `reeval`.
"""

from __future__ import annotations

import glob
import os
import shutil
import signal
import subprocess
import sys
import threading
import time

TIMEOUT = 180


def ctrl_c(process: subprocess.Popen[bytes]) -> None:
    if sys.platform != "win32":
        os.killpg(process.pid, signal.SIGINT)
        return
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    kernel32.FreeConsole()
    if not kernel32.AttachConsole(process.pid):
        sys.exit(f"ctrl-c: couldn't attach to {process.pid}'s console ({ctypes.get_last_error()})")
    kernel32.SetConsoleCtrlHandler(None, True)
    if not kernel32.GenerateConsoleCtrlEvent(0, 0):
        sys.exit(f"ctrl-c: couldn't send CTRL_C_EVENT ({ctypes.get_last_error()})")


def main() -> None:
    pattern, *command = sys.argv[1:]
    command[0] = shutil.which(command[0]) or command[0]
    flags = (
        {"creationflags": subprocess.CREATE_NEW_CONSOLE}  # type: ignore[attr-defined]
        if sys.platform == "win32"
        else {"start_new_session": True}
    )
    if sys.platform == "win32":
        import ctypes

        # A process started with Ctrl-C ignored (as CI runners start jobs) passes that on to every
        # child; a terminal doesn't, so the command gets it enabled.
        ctypes.windll.kernel32.SetConsoleCtrlHandler(None, False)  # type: ignore[attr-defined]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **flags)
    assert process.stdout

    def copy() -> None:
        for chunk in iter(lambda: process.stdout.read1(65536), b""):  # type: ignore[union-attr]
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()

    copier = threading.Thread(target=copy, daemon=True)
    copier.start()
    deadline = time.monotonic() + TIMEOUT
    while not glob.glob(pattern) and process.poll() is None:
        if time.monotonic() > deadline:
            process.kill()
            sys.exit(f"ctrl-c: nothing matched {pattern} in {TIMEOUT}s")
        time.sleep(0.2)
    if process.poll() is not None:
        copier.join(5)
        sys.exit(f"ctrl-c: the command exited ({process.returncode}) before {pattern} appeared")
    time.sleep(2)
    print(f"ctrl-c: pressing Ctrl-C ({pattern} exists)", flush=True)
    ctrl_c(process)
    try:
        code = process.wait(TIMEOUT)
    except subprocess.TimeoutExpired:
        process.kill()
        sys.exit(f"ctrl-c: still running {TIMEOUT}s after Ctrl-C")
    copier.join(5)
    print(f"ctrl-c: exit {code}", flush=True)
    sys.exit(code)


if __name__ == "__main__":
    main()
