#!/usr/bin/env python3
"""BioMed-QAgent.exe: windowed shim handing off to the bundle desktop entry.

Built by scripts/pack-release.mjs (win bundle only) with PyInstaller from the
packaging/windows environment. All launcher logic lives in desktop-app.py
(host spawn, URL banner parsing, health wait, pywebview window with browser
fallback) so the exe and start.bat share a single code path; the shim only
locates the bundle root next to itself, runs the embedded runtime python on
desktop-app.py, and forwards its exit code. Child output lands in
launcher.log next to the exe because a windowed exe has no console.
"""

from __future__ import annotations

import os
import subprocess
import sys

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def bundle_root() -> str:
    if getattr(sys, "frozen", False):
        # PyInstaller exe: the bundle root is the exe's own directory.
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def main() -> int:
    root = bundle_root()
    python = os.path.join(root, "runtime", "python", "python.exe")
    entry = os.path.join(root, "desktop-app.py")
    log_path = os.path.join(root, "launcher.log")
    if not os.path.isfile(python) or not os.path.isfile(entry):
        with open(log_path, "w", encoding="utf-8") as log:
            log.write(
                "[exe] bundle layout error: runtime\\python\\python.exe "
                "or desktop-app.py missing\n"
            )
        return 1
    with open(log_path, "w", encoding="utf-8") as log:
        completed = subprocess.run(
            [python, entry],
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            # A windowed exe has no console to inherit; without this flag the
            # console-subsystem python would allocate its own empty black
            # console window.
            creationflags=CREATE_NO_WINDOW,
        )
    return completed.returncode


if __name__ == "__main__":
    sys.exit(main())
