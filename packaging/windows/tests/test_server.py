"""Tests for server spawn orchestration (fake process, no real node involved)."""

from __future__ import annotations

import io
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path

import pytest
from biomed_launcher.server import (
    ManagedServer,
    build_child_env,
    extract_server_url,
    node_bin_for,
    python_bin_for,
    server_command,
)


class FakeProcess:
    def __init__(self, stdout: bytes, exit_code: int | None = None) -> None:
        self.stdout: io.BytesIO = io.BytesIO(stdout)
        self.stderr: io.BytesIO = io.BytesIO()
        self.pid = 4242
        self._exit_code = exit_code
        self.waited = threading.Event()

    def poll(self) -> int | None:
        return self._exit_code

    def wait(self, timeout: float | None = None) -> int | None:
        self.waited.set()
        return self._exit_code

    def terminate(self) -> None:
        self._exit_code = 0


def spawn(fake: FakeProcess) -> Callable[..., FakeProcess]:
    return lambda *args, **kwargs: fake


def test_extract_server_url() -> None:
    assert extract_server_url("BIOMED_QAGENT_URL=http://127.0.0.1:5173") == "http://127.0.0.1:5173"
    assert extract_server_url("  BIOMED_QAGENT_URL=http://[::1]:8080/  ") == "http://[::1]:8080/"
    assert extract_server_url("BIOMED_QAGENT_URL=") is None
    assert extract_server_url("  ➜ Local: http://127.0.0.1:5173/") is None


def test_server_command_layout(tmp_path: Path) -> None:
    command = server_command(tmp_path)
    assert command[0] == str(node_bin_for(tmp_path))
    assert command[1] == f"--env-file-if-exists={tmp_path / '.env'}"
    assert command[2] == str(tmp_path / "server" / "dist" / "index.js")
    assert command[3] == "--static"


def test_python_bin_matches_runtime_layout(tmp_path: Path) -> None:
    path = python_bin_for(tmp_path)
    parts = path.parts
    if os.name == "nt":
        assert parts[-3:-1] == ("runtime", "python")
        assert parts[-1] == "python.exe"
    else:
        assert parts[-4:-2] == ("runtime", "python")
        assert parts[-2] == "bin"
        assert parts[-1].startswith("python")


def test_build_child_env_promotes_env_file_and_sets_python_bin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("BIOMED_PYTHON_BIN", raising=False)
    monkeypatch.setenv("PORT", "7000")
    env = build_child_env(tmp_path, {"PORT": "6000", "HOST": "0.0.0.0", "OTHER": "x"})
    assert env["PORT"] == "7000"  # real environment wins, like node --env-file
    assert env["HOST"] == "0.0.0.0"
    assert env["OTHER"] == "x"
    assert env["BIOMED_PYTHON_BIN"] == str(python_bin_for(tmp_path))


def test_wait_ready_prefers_stdout_url(tmp_path: Path) -> None:
    stdout = (
        b"BioMed-QAgent starting...\n"
        b"BIOMED_QAGENT_URL=http://127.0.0.1:9310\n"
        b"  BioMed-QAgent ready in 900 ms\n"
    )
    managed = ManagedServer(tmp_path, [], {}, popen=spawn(FakeProcess(stdout)))
    managed.start()
    url = managed.wait_ready(
        "http://127.0.0.1:5173", time.monotonic() + 5, probe=lambda _base: True
    )
    assert url == "http://127.0.0.1:9310"
    assert managed.exited.wait(timeout=1)


def test_wait_ready_never_probes_fallback_while_own_server_is_starting(
    tmp_path: Path,
) -> None:
    """A slow own server must never attach the window to a foreign instance.

    Regression: the old logic probed the fallback (default-port) URL while the
    bundle's own node was still initializing, so when 5173 was occupied by a
    permanent BioMed-QAgent deployment, the window opened against that
    deployment instead of the bundle.
    """
    read_fd, write_fd = os.pipe()
    os.write(write_fd, b"BIOMED_QAGENT_URL=http://127.0.0.1:9310\n")
    fake = FakeProcess(b"")
    fake.stdout = os.fdopen(read_fd, "rb")
    managed = ManagedServer(tmp_path, [], {}, popen=spawn(fake))
    try:
        managed.start()
        probed: list[str] = []
        own_calls = 0

        def probe(base: str) -> bool:
            nonlocal own_calls
            probed.append(base)
            if base == "http://127.0.0.1:9310":
                own_calls += 1
                return own_calls >= 3  # own server: 503, 503, … then ready
            return True  # the foreign instance on the default port is healthy

        url = managed.wait_ready(
            "http://127.0.0.1:5173",
            time.monotonic() + 5,
            probe=probe,
            sleep=lambda _seconds: time.sleep(0.05),
        )
        assert url == "http://127.0.0.1:9310"
        assert probed and all(u == "http://127.0.0.1:9310" for u in probed)
    finally:
        os.close(write_fd)
        fake.stdout.close()


def test_wait_ready_already_running_keeps_probing_fallback(tmp_path: Path) -> None:
    managed = ManagedServer(
        tmp_path, [], {}, popen=spawn(FakeProcess(b"BioMed-QAgent is already running.\n", 0))
    )
    managed.start()
    calls: list[str] = []

    def probe(base: str) -> bool:
        calls.append(base)
        return len(calls) >= 2

    url = managed.wait_ready("http://127.0.0.1:5173", time.monotonic() + 5, probe=probe)
    assert url == "http://127.0.0.1:5173"
    assert managed.already_running is True
    assert managed.exited.wait(timeout=1)


def test_wait_ready_returns_none_when_server_exits(tmp_path: Path) -> None:
    managed = ManagedServer(
        tmp_path, [], {}, popen=spawn(FakeProcess(b"Application Host failed to start\nboom\n", 1))
    )
    managed.start()
    url = managed.wait_ready(
        "http://127.0.0.1:5173", time.monotonic() + 5, probe=lambda _base: False
    )
    assert url is None
    assert managed.already_running is False
    assert any("boom" in line for line in managed.output_tail)
    assert managed.exited.wait(timeout=1)


def test_stop_is_noop_when_process_already_exited(tmp_path: Path) -> None:
    managed = ManagedServer(tmp_path, [], {}, popen=spawn(FakeProcess(b"", 0)))
    managed.start()

    def must_not_kill(pid: int) -> None:
        raise AssertionError(f"should not kill pid {pid}")

    managed.stop(killer=must_not_kill)


def test_stop_kills_process_tree_when_running(tmp_path: Path) -> None:
    fake = FakeProcess(b"")
    managed = ManagedServer(tmp_path, [], {}, popen=spawn(fake))
    managed.start()
    killed: list[int] = []
    managed.stop(killer=killed.append)
    assert killed == [fake.pid]
    assert fake.waited.is_set()
