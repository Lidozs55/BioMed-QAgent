#!/usr/bin/env python3
"""BioMed-QAgent desktop entry: pywebview window with browser fallback.

The platform launcher (start.sh / start.bat, or a Windows exe wrapper) runs
this script with the embedded runtime python. It spawns the embedded node
Application Host in --static mode, resolves the actual URL from the host
banner line (so the OS-assigned port fallback stays transparent), waits for
/api/v1/health, then opens a pywebview native window. When pywebview or its
platform backend is unavailable (e.g. Linux without WebKitGTK) it falls back
to the system default browser and keeps serving in the foreground.

Run with --self-test to exercise the pure helpers without spawning anything.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path
from queue import Empty, Queue

HOST_START_TIMEOUT_SECONDS = 60.0
HEALTH_TIMEOUT_SECONDS = 180.0
HEALTH_POLL_INTERVAL_SECONDS = 0.5
HOST_STOP_TIMEOUT_SECONDS = 10.0
WINDOW_TITLE = "BioMed QAgent"
URL_BANNER_PREFIX = "BIOMED_QAGENT_URL="


def package_root() -> Path:
    """Bundle root: the directory this script lives in."""

    return Path(__file__).resolve().parent


def embedded_node_bin(root: Path) -> Path:
    if os.name == "nt":
        return root / "runtime" / "node" / "node.exe"
    return root / "runtime" / "node" / "bin" / "node"


def embedded_python_bin(root: Path) -> Path:
    if os.name == "nt":
        return root / "runtime" / "python" / "python.exe"
    suffix = f"{sys.version_info.major}.{sys.version_info.minor}"
    return root / "runtime" / "python" / "bin" / f"python{suffix}"


def host_command(root: Path) -> list[str]:
    return [
        str(embedded_node_bin(root)),
        "--env-file-if-exists=.env",
        str(root / "server" / "dist" / "index.js"),
        "--static",
    ]


def parse_banner_url(line: str | bytes) -> str | None:
    """Extract the base URL from a `BIOMED_QAGENT_URL=<url>` banner line."""

    text = line.decode("utf-8", "replace") if isinstance(line, bytes) else line
    text = text.strip()
    if not text.startswith(URL_BANNER_PREFIX):
        return None
    url = text[len(URL_BANNER_PREFIX) :].strip()
    if url.startswith(("http://", "https://")):
        return url
    return None


def wait_for_health(base_url: str, timeout_seconds: float) -> bool:
    """Poll /api/v1/health until it answers 2xx or the deadline passes."""

    health_url = base_url.rstrip("/") + "/api/v1/health"
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(health_url, timeout=2.0) as response:
                if 200 <= response.status < 300:
                    return True
        except OSError:
            pass
        time.sleep(HEALTH_POLL_INTERVAL_SECONDS)
    return False


def spawn_host(root: Path) -> subprocess.Popen[bytes]:
    env = dict(os.environ)
    embedded_python = embedded_python_bin(root)
    if embedded_python.is_file():
        env.setdefault("BIOMED_PYTHON_BIN", str(embedded_python))
    return subprocess.Popen(
        host_command(root),
        cwd=str(root),
        env=env,
        stdout=subprocess.PIPE,
        stderr=None,
    )


def resolve_base_url(process: subprocess.Popen[bytes], timeout_seconds: float) -> str | None:
    """Read host stdout lines until the banner reports the actual base URL."""

    stream = process.stdout
    if stream is None:
        return None
    lines: Queue[bytes | None] = Queue()

    def pump() -> None:
        for raw in stream:
            lines.put(raw)
        lines.put(None)

    threading.Thread(target=pump, daemon=True).start()
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        try:
            item = lines.get(timeout=max(0.1, remaining))
        except Empty:
            return None
        if item is None:
            return None
        url = parse_banner_url(item)
        if url is not None:
            return url
    return None


def open_native_window(url: str) -> bool:
    """Open a pywebview window; False when the backend is unavailable."""

    try:
        import webview
    except Exception:
        return False
    try:
        webview.create_window(WINDOW_TITLE, url, width=1440, height=900, min_size=(1024, 640))
        webview.start()
        return True
    except Exception:
        # Backend import failures (missing WebView2 runtime, WebKitGTK, ...)
        # surface here; the caller falls back to the system browser.
        return False


def stop_host(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=HOST_STOP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=HOST_STOP_TIMEOUT_SECONDS)


def run() -> int:
    root = package_root()
    node_bin = embedded_node_bin(root)
    host_entry = root / "server" / "dist" / "index.js"
    if not node_bin.is_file() or not host_entry.is_file():
        print("[desktop] bundle layout error: embedded node or server/dist missing")
        return 1

    print("[desktop] starting BioMed-QAgent host...")
    process = spawn_host(root)
    try:
        base_url = resolve_base_url(process, HOST_START_TIMEOUT_SECONDS)
        if base_url is None:
            print("[desktop] host did not report its URL; see host output above")
            return 1
        print(f"[desktop] host at {base_url}")
        if not wait_for_health(base_url, HEALTH_TIMEOUT_SECONDS):
            print("[desktop] host did not become healthy in time; see host output above")
            return 1
        if open_native_window(base_url):
            return 0
        print("[desktop] native window unavailable; opening the system browser")
        if not webbrowser.open(base_url):
            print(f"[desktop] no browser found; open {base_url} manually (Ctrl+C to stop)")
        # Foreground service mode: serve until the host exits or Ctrl+C.
        process.wait()
        return process.returncode if process.returncode is not None else 0
    except KeyboardInterrupt:
        print("[desktop] interrupted; stopping host")
        return 0
    finally:
        stop_host(process)


def self_test() -> int:
    failures: list[str] = []

    def check(name: str, condition: bool) -> None:
        status = "ok" if condition else "FAIL"
        print(f"{status} - {name}")
        if not condition:
            failures.append(name)

    check(
        "banner url parsed with crlf line ending",
        parse_banner_url(b"BIOMED_QAGENT_URL=http://127.0.0.1:5173\r\n")
        == "http://127.0.0.1:5173",
    )
    check("banner url rejects non-http scheme", parse_banner_url("BIOMED_QAGENT_URL=ftp://x") is None)
    check("banner url ignores unrelated lines", parse_banner_url("BioMed-QAgent ready in 12 ms") is None)
    check("empty line ignored", parse_banner_url("") is None)

    root = package_root()
    command = host_command(root)
    check(
        "host entry is server/dist/index.js",
        any(part.endswith("server/dist/index.js") for part in command),
    )
    check("host runs in static mode", "--static" in command)
    check("host honors optional .env", "--env-file-if-exists=.env" in command)
    node_bin = embedded_node_bin(root)
    check(
        "node binary path is runtime-relative on every platform",
        "runtime" in node_bin.parts and (node_bin.name == "node" or node_bin.name == "node.exe"),
    )

    verdict = "PASS" if not failures else "FAIL"
    print(f"{verdict}: desktop-app self-test ({len(failures)} failures)")
    return 0 if not failures else 1


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    return run()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
