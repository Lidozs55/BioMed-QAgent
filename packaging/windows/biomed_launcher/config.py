"""Bundle layout, optional ``.env`` parsing and logging for the GUI launcher.

The launcher ships inside the portable bundle produced by
``scripts/pack-release.mjs`` and only consumes that layout: it points the
Application Host at the embedded bridge runtime via ``BIOMED_PYTHON_BIN``
(the same integration point ``start.bat`` uses) and mirrors the optional
bundle ``.env`` so its own URL resolution matches what node's
``--env-file-if-exists`` passes to the server.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

DEFAULT_PORT = 5173
DEFAULT_HOST = "127.0.0.1"
ENV_FILE_NAME = ".env"
LOG_FILE_NAME = "launcher.log"
WINDOW_TITLE = "BioMed-QAgent"
ICON_RESOURCE_NAME = "biomed-qagent.ico"
#: set to a non-empty value other than "0"/"false" to skip the desktop window
FORCE_BROWSER_ENV = "BIOMED_FORCE_BROWSER"


def is_frozen() -> bool:
    """True when running from the PyInstaller exe."""
    return getattr(sys, "frozen", False)


def bundle_root() -> Path:
    """Portable bundle directory.

    PyInstaller onefile extracts embedded payloads into a temp dir
    (``sys._MEIPASS``), but the bundle contents (``runtime/``, ``server/``,
    ``frontend/``) always sit next to the exe itself.
    """
    if is_frozen():
        return Path(sys.executable).resolve().parent
    # Dev checkout: <repo>/packaging/windows/biomed_launcher/config.py → repo root.
    return Path(__file__).resolve().parents[3]


def resource_path(name: str) -> Path | None:
    """Path of a file embedded by PyInstaller, or None outside a frozen exe."""
    base = getattr(sys, "_MEIPASS", None)
    if base is None:
        return None
    candidate = Path(base) / name
    return candidate if candidate.exists() else None


def parse_env_file(text: str) -> dict[str, str]:
    """Parse the ``.env`` subset bundles actually use.

    Mirrors what the server consumes through node's ``--env-file-if-exists``:
    full-line ``#`` comments, blank lines, an optional ``export`` prefix, and
    single/double-quoted values. Inline comments are not a thing in either
    parser — keep comments on their own line.
    """
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def load_env_file(bundle: Path) -> dict[str, str]:
    """Parse the optional bundle ``.env``; a missing or unreadable file is `{}`."""
    env_path = bundle / ENV_FILE_NAME
    if not env_path.is_file():
        return {}
    try:
        # utf-8-sig: Notepad on Windows still writes a BOM by default.
        return parse_env_file(env_path.read_text(encoding="utf-8-sig"))
    except OSError:
        logging.getLogger(__name__).warning("cannot read %s; ignoring it", env_path, exc_info=True)
        return {}


def resolve_port(process_env: dict[str, str], env_file: dict[str, str]) -> int:
    """Effective PORT with node ``--env-file`` precedence: real env > .env > default.

    Unlike the server (which hard-fails on invalid values), an unparsable PORT
    falls back to the default: the misconfiguration surfaces through the server
    startup failure dialog instead of crashing the launcher.
    """
    raw = process_env.get("PORT") or env_file.get("PORT")
    if raw is None or not raw.strip():
        return DEFAULT_PORT
    try:
        port = int(raw.strip())
    except ValueError:
        return DEFAULT_PORT
    return port if 0 <= port <= 65535 else DEFAULT_PORT


def resolve_host(process_env: dict[str, str], env_file: dict[str, str]) -> str:
    """Effective HOST, mapped to a loopback browser target like the server banner."""
    host = (process_env.get("HOST") or env_file.get("HOST") or DEFAULT_HOST).strip()
    if not host or host in {"0.0.0.0", "::"}:
        return DEFAULT_HOST
    return host


def setup_logging(log_file: Path) -> None:
    """Log to ``<bundle>/launcher.log`` (truncated per run).

    Falls back to a sink handler when the bundle directory is read-only: with
    the console hidden, an unusable log file must not take the launcher down.
    """
    try:
        handler: logging.Handler = logging.FileHandler(log_file, mode="w", encoding="utf-8")
    except OSError:
        handler = logging.NullHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
