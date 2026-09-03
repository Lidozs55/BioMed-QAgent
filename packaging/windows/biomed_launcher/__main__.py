"""``python -m biomed_launcher`` entrypoint (PyInstaller target via launcher_entry.py)."""

from __future__ import annotations

from biomed_launcher.app import run


def main() -> int:
    return run()


if __name__ == "__main__":
    raise SystemExit(main())
