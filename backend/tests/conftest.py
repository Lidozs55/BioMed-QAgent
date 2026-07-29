"""Shared pytest fixtures for all tests."""

from __future__ import annotations

import contextlib
from pathlib import Path

import pytest


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Deselect live tests by default without blocking explicit live selection."""

    requested_args = tuple(
        str(argument).replace("\\", "/") for argument in config.invocation_params.args
    )
    explicitly_requested_live_file = any("tests/live/" in argument for argument in requested_args)
    if config.getoption("markexpr") or explicitly_requested_live_file:
        return
    live_items = [item for item in items if item.get_closest_marker("live") is not None]
    if not live_items:
        return
    config.hook.pytest_deselected(items=live_items)
    items[:] = [item for item in items if item.get_closest_marker("live") is None]


@pytest.fixture(autouse=True)
def _disable_rate_limiter(monkeypatch: pytest.MonkeyPatch) -> None:
    """Disable all rate limiters during tests to avoid 2s delays.

    The async crawler limiter is lifespan-owned and explicitly configured by
    its tests. This fixture only patches legacy per-module limiters that remain
    in independent acquisition skills.
    """
    for module_path in (
        "app.skills.builtin.acquisition.gdc._rate_limit",
        "app.skills.builtin.acquisition.pdb._rate_limit",
        "app.skills.builtin.acquisition.xena._rate_limit",
    ):
        # Skill module may not be importable in all test environments.
        with contextlib.suppress(AttributeError, ModuleNotFoundError):
            monkeypatch.setattr(module_path, lambda: None)


@pytest.fixture
def runnable_agent_model_settings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Provide an explicitly known model only to opted-in Agent execution tests."""

    import app.model_settings as model_settings
    from app.config import Settings

    store = model_settings.ModelSettingsStore(
        tmp_path / "settings" / "model.json",
        defaults=Settings(model_name="qwen-plus"),
    )
    monkeypatch.setattr(model_settings, "_current_store", store)
