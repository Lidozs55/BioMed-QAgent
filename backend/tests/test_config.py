"""配置测试 — 验证 Settings 加载和默认值。"""

from __future__ import annotations

import re
from pathlib import Path

from app.config import Settings, settings


def test_settings_has_dashscope_api_key() -> None:
    assert hasattr(settings, "dashscope_api_key")
    assert isinstance(settings.dashscope_api_key, str)


def test_settings_has_dashscope_base_url() -> None:
    assert hasattr(settings, "dashscope_base_url")
    assert (
        "dashscope" in settings.dashscope_base_url
        or "compatible-mode" in settings.dashscope_base_url
    )


def test_settings_has_model_name() -> None:
    assert hasattr(settings, "model_name")
    assert settings.model_name.startswith("qwen")


def test_settings_has_host_and_port() -> None:
    assert hasattr(settings, "host")
    assert hasattr(settings, "port")
    assert isinstance(settings.port, int)
    assert settings.port > 0


def test_settings_has_output_dir() -> None:
    assert hasattr(settings, "output_dir")
    assert isinstance(settings.output_dir, str)
    assert len(settings.output_dir) > 0


def test_output_dir_default_is_absolute() -> None:
    """OUTPUT_DIR 默认值是绝对路径，避免 cwd 变化导致输出散落。"""
    configured = Settings()
    assert Path(configured.output_dir).is_absolute()


def test_rate_limit_settings_default() -> None:
    """rate_limit_seconds 提供可配置默认值。"""
    configured = Settings()
    assert configured.rate_limit_seconds == 2.0


def test_settings_is_frozen() -> None:
    """Settings 是 frozen dataclass，不可变。"""
    import pytest

    with pytest.raises((AttributeError, TypeError)):
        settings.host = "0.0.0.0"  # type: ignore[misc]


def test_runtime_concurrency_defaults_are_bounded() -> None:
    configured = Settings()

    assert configured.runtime_max_active_runs == 4
    assert configured.runtime_sync_worker_threads == 4
    assert configured.runtime_run_queue_size == 100
    assert configured.runtime_subscriber_queue_size == 1000


# ---------------------------------------------------------------------------
# TODO §1.6 — 配置完整性
#
# Regression guards for the .env.example / pyproject.toml / requirements.txt
# synchronization work. Without these guards, the three config files can
# silently drift (a dep is added to pyproject.toml but not requirements.txt,
# a settings field is added but .env.example is not updated, a dead dep is
# resurrected after a refactor, etc.).
# ---------------------------------------------------------------------------

# Repo root (backend/..) — test_config.py lives in backend/tests/.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _read_pyproject_runtime_deps() -> set[str]:
    """Return the set of runtime dependency package names declared in
    ``backend/pyproject.toml`` under ``[project].dependencies``.

    Each entry like ``"pdfplumber>=0.11.0"`` is normalized to ``"pdfplumber"``.
    Extras like ``"uvicorn[standard]>=0.30.0"`` become ``"uvicorn"``.

    Uses ``tomllib`` (Python 3.11+ stdlib) instead of regex — a regex approach
    cannot reliably handle PEP 508 entries that themselves contain ``[``
    and ``]`` (e.g. ``uvicorn[standard]``), because the bracket-balancing
    semantics of TOML arrays conflict with naive non-greedy matching.
    """
    import tomllib

    with (_BACKEND_ROOT / "pyproject.toml").open("rb") as f:
        data = tomllib.load(f)
    raw_deps = data.get("project", {}).get("dependencies", [])
    names: set[str] = set()
    for entry in raw_deps:
        # Strip version specifiers and extras: "uvicorn[standard]>=0.30.0" -> "uvicorn"
        name = re.split(r"[\s<>=!\[]", entry, maxsplit=1)[0].strip()
        if name:
            names.add(name.lower())
    return names


def test_env_example_contains_ncbi_config() -> None:
    """TODO §1.6 P0: .env.example must document all NCBI config items.

    Without these, a new contributor running ``cp .env.example .env`` would
    silently fall back to the placeholder defaults — ``NCBI_API_KEY=""``
    (3 req/s instead of 10 req/s) and a fake ``BioMed-QAgent/0.1`` UA.
    """
    env_example = (_REPO_ROOT / ".env.example").read_text(encoding="utf-8")

    for key in ("NCBI_EMAIL", "NCBI_TOOL", "NCBI_API_KEY", "NCBI_USER_AGENT"):
        assert key in env_example, (
            f".env.example missing NCBI config item: {key}"
        )


def test_pyproject_does_not_declare_dead_deps() -> None:
    """TODO §1.6 P0: pyproject.toml must not declare dead dependencies.

    - ``biopython``: removed in §1.5 (download_supplementary now routes
      through NcbiEutilsClient; test_pubmed_module_does_not_import_biopython
      guards against resurrection).
    - ``geoparse``: declared but never imported anywhere in app/ or tests/
      (research confirmed during §1.6).
    """
    deps = _read_pyproject_runtime_deps()
    assert "biopython" not in deps, (
        "biopython is dead dep — §1.5 removed last usage; "
        "remove from pyproject.toml [project].dependencies"
    )
    assert "geoparse" not in deps, (
        "geoparse is dead dep — never imported in app/ or tests/; "
        "remove from pyproject.toml [project].dependencies"
    )


def test_pyproject_description_is_not_template() -> None:
    """TODO §1.6 P0: pyproject.toml description must not be the uv template
    default ``"Add your description here"``."""
    content = (_BACKEND_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^description\s*=\s*"([^"]+)"', content, re.MULTILINE)
    assert match is not None, "pyproject.toml description not found"
    description = match.group(1)
    assert description != "Add your description here", (
        "pyproject.toml description is still the uv template default"
    )
    assert len(description) > 10, (
        f"pyproject.toml description too short: {description!r}"
    )


def test_requirements_txt_in_sync_with_pyproject_runtime_deps() -> None:
    """TODO §1.6 P0: requirements.txt must mirror pyproject.toml runtime deps.

    ``requirements.txt`` is consumed by ``.github/workflows/package.yml`` for
    the Windows PyInstaller packaging step. If it drifts from
    ``pyproject.toml [project].dependencies``, the packaged executable will
    silently miss a runtime dep — the failure surfaces only at runtime on
    the end user's machine.

    This guard compares the normalized package-name set (case-insensitive,
    extras/version-stripped) across the two files.
    """
    req_text = (_BACKEND_ROOT / "requirements.txt").read_text(encoding="utf-8")
    req_names: set[str] = set()
    for line in req_text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name = re.split(r"[\s<>=!\[]", line, maxsplit=1)[0].strip()
        if name:
            req_names.add(name.lower())

    pyproject_deps = _read_pyproject_runtime_deps()

    missing_from_req = pyproject_deps - req_names
    extra_in_req = req_names - pyproject_deps

    assert not missing_from_req, (
        f"requirements.txt missing deps that pyproject.toml declares: "
        f"{sorted(missing_from_req)}"
    )
    assert not extra_in_req, (
        f"requirements.txt has deps not in pyproject.toml: "
        f"{sorted(extra_in_req)}"
    )
