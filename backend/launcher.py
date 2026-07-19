"""PyInstaller-compatible entry point for BioMed-QAgent desktop app.

Starts a uvicorn server, serves the embedded frontend ``dist/`` as static
files, and auto-opens the user's browser.

Reuses ``app.main.create_app`` (which owns the durable runtime lifespan)
and layers static-file serving on top.
"""
from __future__ import annotations

import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn
from app.main import create_app as _create_runtime_app
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# dist/ resolution
# ---------------------------------------------------------------------------


def _get_dist_path() -> Path | None:
    """Resolve the frontend ``dist/`` directory.

    Handles three scenarios in order:

    1. **PyInstaller frozen** — looks for ``dist/`` inside ``sys._MEIPASS``.
    2. **Source (default)** — ``../frontend/dist/`` relative to this file.
    3. **Source (fallback)** — ``dist/`` in the same directory as this file.

    Returns:
        Absolute ``Path`` to ``dist/``, or ``None`` if not found.
    """
    # Scenario 1 — PyInstaller bundle
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        # `_MEIPASS` is injected by PyInstaller at runtime; it is not in the
        # stdlib `sys` type stubs. Use `getattr` (not direct access) so pyright
        # does not flag an unknown attribute, and suppress ruff B009 since the
        # constant attribute name is intentional for this dynamic field.
        meipass = getattr(sys, "_MEIPASS")  # noqa: B009
        candidate = Path(meipass) / "dist"
        if candidate.is_dir():
            return candidate.resolve()
        return None

    # Scenario 2 — running from source: backend/launcher.py → ../frontend/dist/
    script_dir = Path(__file__).resolve().parent
    candidate = script_dir.parent / "frontend" / "dist"
    if candidate.is_dir():
        return candidate.resolve()

    # Scenario 3 — dist/ copied into backend/
    candidate = script_dir / "dist"
    if candidate.is_dir():
        return candidate.resolve()

    return None


# ---------------------------------------------------------------------------
# FastAPI application factory
# ---------------------------------------------------------------------------


def create_app(dist_path: Path | None = None) -> FastAPI:
    """Create the FastAPI application instance with durable runtime lifespan.

    Reuses ``app.main.create_app`` (which registers the lifespan that owns
    TaskManager, TaskRepository, EventHub, etc.) and layers static-file
    serving on top when ``dist_path`` is provided.

    Args:
        dist_path: Path to the frontend ``dist/`` directory. When provided
            and the directory exists, static files are served from it with
            an SPA fallback (``index.html`` for non-file paths).

    Returns:
        Configured ``FastAPI`` instance.
    """
    app = _create_runtime_app()

    # ── Static file serving + SPA fallback ──
    if dist_path is not None and dist_path.is_dir():
        app.mount(
            "/",
            StaticFiles(directory=str(dist_path), html=True),
            name="static",
        )

        @app.get("/{full_path:path}")
        async def _spa_fallback(full_path: str = "") -> FileResponse:
            """Catch-all: serve ``index.html`` for any unmatched route."""
            _ = full_path  # unused — StaticFiles already handled it
            return FileResponse(str(dist_path / "index.html"))

    return app


# ---------------------------------------------------------------------------
# Desktop entry point
# ---------------------------------------------------------------------------


def main() -> None:
    """Entry point for the packaged desktop application.

    Reads ``HOST`` / ``PORT`` from environment (defaulting to
    ``127.0.0.1:8000``), resolves the frontend ``dist/``, creates the
    FastAPI app, and starts uvicorn.  When ``dist/`` is found the browser
    is auto-opened on a background thread (after a short delay to let the
    server come up).
    """
    import os

    from app.config import settings

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))

    dist_path = _get_dist_path()
    app = create_app(dist_path)

    if dist_path is not None and dist_path.is_dir():
        url = f"http://{host}:{port}"
        print(f"BioMed-QAgent running at {url}")

        # Open browser after a short delay so uvicorn is ready
        threading.Thread(
            target=lambda: (time.sleep(0.5), webbrowser.open(url)),
            daemon=True,
        ).start()

    uvicorn.run(app, host=host, port=port, log_level=settings.log_level.lower())


if __name__ == "__main__":
    main()
