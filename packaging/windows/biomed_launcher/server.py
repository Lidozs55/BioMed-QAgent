"""Spawn and monitor the embedded Node Application Host.

Pure orchestration: the launcher is a shell around the exact production
entrypoint ``start.bat`` runs. The URL the server actually binds is taken from
the ``BIOMED_QAGENT_URL=`` line on its stdout, so the OS-assigned-port path
(``PORT`` busy) keeps working.
"""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO

logger = logging.getLogger(__name__)

URL_LINE_PREFIX = "BIOMED_QAGENT_URL="
ALREADY_RUNNING_MESSAGE = "BioMed-QAgent is already running."
HEALTH_PATH = "/api/v1/health"
HEALTH_PROBE_TIMEOUT = 2.0
POLL_INTERVAL = 0.25
#: first run on a target machine may pay antivirus scan costs for the whole
#: embedded runtime, so the ceiling is generous rather than tight
DEFAULT_STARTUP_TIMEOUT = 120.0
OUTPUT_TAIL_LINES = 60
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

HealthProbe = Callable[[str], bool]


def python_bin_for(bundle: Path) -> Path:
    """Embedded bridge interpreter (the path start.bat exports as BIOMED_PYTHON_BIN)."""
    if os.name == "nt":
        return bundle / "runtime" / "python" / "python.exe"
    return bundle / "runtime" / "python" / "bin" / "python3.12"


def node_bin_for(bundle: Path) -> Path:
    """Embedded Node.js runtime."""
    if os.name == "nt":
        return bundle / "runtime" / "node" / "node.exe"
    return bundle / "runtime" / "node" / "bin" / "node"


def server_command(bundle: Path) -> list[str]:
    """Same production entrypoint as start.bat / start.sh."""
    return [
        str(node_bin_for(bundle)),
        f"--env-file-if-exists={bundle / '.env'}",
        str(bundle / "server" / "dist" / "index.js"),
        "--static",
    ]


def build_child_env(bundle: Path, env_file: dict[str, str]) -> dict[str, str]:
    """Child environment: the real environment wins over ``.env`` (node
    ``--env-file`` precedence), plus the launcher-only ``BIOMED_PYTHON_BIN``
    integration point consumed by ``server/src/persistence/db-client.ts``."""
    child = dict(os.environ)
    for key, value in env_file.items():
        child.setdefault(key, value)
    child["BIOMED_PYTHON_BIN"] = str(python_bin_for(bundle))
    return child


def extract_server_url(line: str) -> str | None:
    """Parse the ``BIOMED_QAGENT_URL=<base>`` banner line; None otherwise."""
    stripped = line.strip()
    if not stripped.startswith(URL_LINE_PREFIX):
        return None
    url = stripped[len(URL_LINE_PREFIX) :].strip()
    return url or None


def probe_health(base_url: str) -> bool:
    """True only once ``/api/v1/health`` answers 200 (503 = still starting)."""
    try:
        with urllib.request.urlopen(
            base_url.rstrip("/") + HEALTH_PATH, timeout=HEALTH_PROBE_TIMEOUT
        ) as response:
            return getattr(response, "status", 0) == 200
    except urllib.error.HTTPError:
        # 503 while initializing, or some other process answering on the port.
        return False
    except (urllib.error.URLError, OSError, ValueError):
        return False


class ManagedServer:
    """Owns the node child process and its stdout-driven URL discovery."""

    def __init__(
        self,
        bundle: Path,
        command: list[str],
        env: dict[str, str],
        popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
    ) -> None:
        self._bundle = bundle
        self._command = command
        self._env = env
        self._popen = popen
        self.process: subprocess.Popen[bytes] | None = None
        self.url: str | None = None
        self.already_running = False
        self.exited = threading.Event()
        self.exit_code: int | None = None
        self.output_tail: deque[str] = deque(maxlen=OUTPUT_TAIL_LINES)
        self._reader: threading.Thread | None = None

    def start(self) -> None:
        logger.info("starting server: %s", " ".join(self._command))
        self.process = self._popen(
            self._command,
            cwd=str(self._bundle),
            env=self._env,
            stdout=subprocess.PIPE,
            # merged into one pipe: the tail exists for diagnostics, ordering
            # between the two streams is not load-bearing
            stderr=subprocess.STDOUT,
            creationflags=CREATE_NO_WINDOW,
        )
        assert self.process is not None
        assert self.process.stdout is not None
        self._reader = threading.Thread(
            target=self._read_output, args=(self.process.stdout,), daemon=True
        )
        self._reader.start()

    def _read_output(self, stream: BinaryIO) -> None:
        assert self.process is not None
        for raw in iter(stream.readline, b""):
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            self.output_tail.append(line)
            logger.debug("server: %s", line)
            url = extract_server_url(line)
            if url is not None and self.url is None:
                self.url = url
                logger.info("server reported url %s", url)
            if ALREADY_RUNNING_MESSAGE in line:
                self.already_running = True
        self.exit_code = self.process.poll()
        if self.exit_code is None:
            # Pipe closed while the process is somehow still alive: reap it.
            self.exit_code = self.process.wait()
        self.exited.set()
        logger.info("server exited with code %s", self.exit_code)

    def wait_ready(
        self,
        fallback_url: str,
        deadline: float,
        probe: HealthProbe = probe_health,
        sleep: Callable[[float], None] = time.sleep,
    ) -> str | None:
        """Wait for a healthy base URL; None on startup failure.

        Probes the stdout-reported URL first, then the ``.env``-derived
        fallback (which covers the "already running" path where this
        launcher's own node exits immediately because another instance holds
        the application lock).
        """
        while True:
            for base in dict.fromkeys(url for url in (self.url, fallback_url) if url):
                if probe(base):
                    return base
            if not self.exited.is_set() or self.already_running:
                if time.monotonic() >= deadline:
                    return None
                sleep(POLL_INTERVAL)
                continue
            return None

    def stop(self, timeout: float = 15.0, killer: Callable[[int], None] | None = None) -> None:
        """Stop the child and its process tree once the UI is done.

        A hard tree-kill is the supported exit path for the portable bundle:
        the durable runtime recovers interrupted runs on the next start.
        """
        process = self.process
        if process is None or process.poll() is not None:
            return
        logger.info("stopping server (pid %s)", process.pid)
        kill = killer if killer is not None else self._tree_kill
        try:
            kill(process.pid)
        except OSError:
            logger.warning("tree kill failed; falling back to terminate", exc_info=True)
            process.terminate()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            logger.error("server did not exit after kill; abandoning process")

    @staticmethod
    def _tree_kill(pid: int) -> None:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(pid)],
                creationflags=CREATE_NO_WINDOW,
                check=False,
                capture_output=True,
            )
        else:
            os.kill(pid, signal.SIGTERM)
