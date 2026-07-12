"""PyInstaller-compatible entry point for BioMed-QAgent desktop app.

Starts a uvicorn server, serves the embedded frontend ``dist/`` as static
files, and auto-opens the user's browser.
"""
from __future__ import annotations

import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import router as routes_router
from app.api.ws import router as ws_router


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
        candidate = Path(sys._MEIPASS) / "dist"  # pyright: ignore[reportAttributeAccessIssue]
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
    """Create the FastAPI application instance.

    Args:
        dist_path: Path to the frontend ``dist/`` directory. When provided
            and the directory exists, static files are served from it with
            an SPA fallback (``index.html`` for non-file paths).

    Returns:
        Configured ``FastAPI`` instance.
    """
    app = FastAPI(title="BioMed-QAgent")

    # CORS — allow frontend dev server, same-origin, and future pywebview
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://127.0.0.1:8000",
            "app://.",  # reserved for future pywebview integration
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── API routes (takes precedence over static files) ──
    app.include_router(routes_router)
    app.include_router(ws_router)

    # ── Static file serving + SPA fallback ──
    if dist_path is not None and dist_path.is_dir():
        # Efficiently serve the built assets via StaticFiles.
        # ``html=True`` makes StaticFiles serve ``index.html`` for paths
        # that don't match an existing file — i.e. SPA fallback.
        app.mount(
            "/",
            StaticFiles(directory=str(dist_path), html=True),
            name="static",
        )

        # Additional catch-all route for SPA fallback.
        # (With ``html=True`` above this is technically redundant, but
        # kept for explicitness and to match the desktop-app contract.)
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

    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
