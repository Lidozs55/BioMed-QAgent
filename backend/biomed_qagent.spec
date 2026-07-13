# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for BioMed-QAgent.
=========================================

This file tells PyInstaller how to bundle the backend (``launcher.py``) and
the pre-built frontend (``dist/``) into a single standalone executable that
runs on Windows, macOS, and Linux without requiring Python to be installed.

How it works (high level):
  1.  PyInstaller analyses ``launcher.py`` and traces every ``import`` to
      figure out which Python modules are needed at runtime.
  2.  For packages with compiled C extensions or bundled data files
      (scipy, matplotlib, biopython, ...), static analysis is not enough --
      we explicitly call ``collect_all()`` to grab their data files and
      shared libraries.
  3.  The app dynamically imports skill modules (see ``routes.py``), so we
      use ``collect_submodules('app')`` to make sure every submodule under
      ``app/`` is included.
  4.  The frontend ``dist/`` directory (downloaded in CI as
      ``frontend_dist/``) is bundled as ``dist/`` inside the executable so
      that ``launcher.py`` can find it via ``sys._MEIPASS``.
  5.  Everything is packed into a single file (``--onefile`` mode).

Usage (run from the ``backend/`` directory):

    pyinstaller biomed_qagent.spec --noconfirm

In CI this is invoked by the GitHub Actions workflow after ``uv sync`` and
``uv pip install pyinstaller`` have prepared the virtual environment.
"""

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

# ---------------------------------------------------------------------------
# 1. Collect data files / binaries / hidden imports for "tricky" packages
# ---------------------------------------------------------------------------
#
# Many scientific Python packages ship compiled C extensions (.so / .dll
# / .dylib) or data files (fonts, color maps, codon tables, etc.) that
# PyInstaller's static import analysis cannot discover automatically.
# ``collect_all(pkg)`` returns a 3-tuple ``(datas, binaries, hiddenimports)``
# for the given package, which we accumulate into the spec-level lists.
#
# We wrap each call in try/except so that a missing optional dependency
# does not crash the entire build -- the package simply contributes nothing.

datas: list = []
binaries: list = []
hiddenimports: list = []

# Each entry: (import_name, reason)
_packages_to_collect = [
    ("Bio", "biopython -- motif matrices, codon tables, PubMed parsers"),
    ("scipy", "compiled BLAS/LAPACK, special-function data"),
    ("matplotlib", "fonts, stylesheets, color maps, rcParams defaults"),
    ("numpy", "compiled core + lapack/blas shared libraries"),
    ("pandas", "compiled C/Cython extensions, optional I/O stubs"),
    ("seaborn", "built-in datasets and color palettes"),
    ("geoparse", "GEO SOFT parser -- bundled test / annotation data"),
    ("pydantic", "v2 compiled core (pydantic_core) and schema data"),
    ("pydantic_core", "Rust-compiled validation engine"),
    ("agents", "openai-agents SDK -- tool schemas and internal data"),
    ("openai", "OpenAI client -- bundled type definitions"),
    ("uvicorn", "protocol parsers, lifespan handlers"),
    ("websockets", "C-speedup extension (speedups module)"),
]

for _pkg, _reason in _packages_to_collect:
    try:
        _d, _b, _h = collect_all(_pkg)
        datas += _d
        binaries += _b
        hiddenimports += _h
    except Exception:
        # Package is not installed in this environment -- skip gracefully.
        pass

# ---------------------------------------------------------------------------
# 2. Collect all ``app`` submodules (dynamic imports)
# ---------------------------------------------------------------------------
#
# ``app/api/routes.py`` registers skills via direct import statements:
#
#     import app.skills.builtin.acquisition.gdc
#     import app.skills.builtin.acquisition.geo
#     ...
#
# PyInstaller's static analyser may miss these because they appear as bare
# import statements inside a function body, not at module top-level.
# ``collect_submodules('app')`` enumerates every importable submodule under
# ``app/`` and adds them as hidden imports, guaranteeing nothing is left out.

hiddenimports += collect_submodules("app")

# ---------------------------------------------------------------------------
# 3. Bundle the frontend ``dist/`` directory
# ---------------------------------------------------------------------------
#
# In CI the frontend is built in the quality-gate job and downloaded into
# ``backend/frontend_dist/``.  When running locally you can symlink or copy
# ``../frontend/dist/`` to ``frontend_dist/``.
#
# The tuple ('frontend_dist', 'dist') tells PyInstaller:
#   source on disk  -> frontend_dist/  (the downloaded frontend build)
#   dest in bundle  -> dist/           (where launcher.py expects it)
#
# ``launcher.py`` checks ``sys._MEIPASS / 'dist'`` when frozen, so this
# mapping must be exactly ``dist``.

_frontend_src = "frontend_dist"
if Path(_frontend_src).is_dir():
    datas += [(_frontend_src, "dist")]

# ---------------------------------------------------------------------------
# 4. Analysis -- the main dependency graph
# ---------------------------------------------------------------------------

a = Analysis(
    ["launcher.py"],
    pathex=[],          # no extra sys.path entries needed
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],       # no custom hook scripts
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # --- Not used at runtime ---
        "tkinter",          # GUI toolkit -- pulled in by matplotlib but unused
        "test",             # Python's own test package
        "tests",            # project test suite
        "pytest",           # test runner
        "pytest_asyncio",   # pytest plugin
        "ruff",             # linter
        # --- Unused matplotlib GUI backends (we only use Agg) ---
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

# ---------------------------------------------------------------------------
# 5. EXE -- single-file bundle
# ---------------------------------------------------------------------------
#
# Passing ``a.binaries`` and ``a.datas`` to ``EXE()`` (instead of ``COLLECT()``)
# produces a one-file executable.  At runtime PyInstaller extracts the
# bundle to a temporary directory (``sys._MEIPASS``) and runs from there.
#
# ``console=True`` keeps a terminal window open so users can see server logs.
# For a polished desktop release you may set ``console=False`` (Windows/macOS)
# or ``console=False`` with a log-file redirect.

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="BioMed-QAgent",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,           # UPX can trigger false-positive AV alerts -- disabled
    runtime_tmpdir=None, # use OS default temp directory
    console=True,        # show console window for log visibility
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,    # build for the runner's native architecture
    codesign_identity=None,
    entitlements_file=None,
)
