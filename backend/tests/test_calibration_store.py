"""Persisted context-budget calibration tests."""

from __future__ import annotations

import json
from pathlib import Path

import app.model_settings as model_settings
import pytest
from app.agent_loop.model import to_run_model_settings
from app.config import Settings
from app.model_config.context_budget import ContextBudget
from app.model_settings import ModelSettingsStore


def _calibration_budget(
    provider_origin: str = "https://provider.example",
    model_name: str = "model-a",
) -> ContextBudget:
    return ContextBudget(
        context_window=1000,
        max_output_tokens=100,
        safety_reserve_tokens=100,
        trigger_tokens=680,
        target_tokens=480,
        provider_origin=provider_origin,
        model_name=model_name,
        tokenizer_kind="conservative",
        calibration_margin_tokens=0,
    )


def test_calibration_changes_only_later_run_snapshots(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Given
    store = ModelSettingsStore(
        tmp_path / "settings" / "model.json", defaults=Settings(model_name="qwen-max")
    )
    monkeypatch.setattr(model_settings, "_current_store", store)
    first = to_run_model_settings(store.snapshot())

    # When
    store.record_calibration_residual(first.context_budget, 123)
    later = to_run_model_settings(store.snapshot())

    # Then
    assert first.context_budget.calibration_margin_tokens == 0
    assert later.context_budget.calibration_margin_tokens == 123


def test_calibration_normalizes_origins_without_collapsing_hosts(tmp_path: Path) -> None:
    # Given
    store = ModelSettingsStore(tmp_path / "settings" / "model.json")

    # When
    store.record_calibration_residual(_calibration_budget("HTTPS://Provider.Example:443"), 5)
    store.record_calibration_residual(_calibration_budget("https://other.example"), 7)

    # Then
    assert json.loads(store.calibration_path.read_text("utf-8")) == {
        "https://provider.example|model-a": [5],
        "https://other.example|model-a": [7],
    }


def test_calibration_retains_positive_history_and_caps_margin(tmp_path: Path) -> None:
    # Given
    store = ModelSettingsStore(tmp_path / "settings" / "model.json")
    budget = _calibration_budget()

    # When
    for residual in range(1, 26):
        store.record_calibration_residual(budget, residual)
    store.record_calibration_residual(budget, 0)
    store.record_calibration_residual(budget, -1)
    store.record_calibration_residual(budget, 10_000)

    # Then
    assert json.loads(store.calibration_path.read_text("utf-8")) == {
        "https://provider.example|model-a": [*range(7, 26), 10_000]
    }
    assert store.calibration_margin_for(budget) == 100


@pytest.mark.parametrize(
    "contents",
    ["{not-json}\n", '{"https://provider.example|model-a":["not-a-number"]}\n'],
)
def test_calibration_read_fallback_preserves_missing_or_corrupt_sources(
    tmp_path: Path, contents: str
) -> None:
    # Given
    store = ModelSettingsStore(tmp_path / "settings" / "model.json")
    assert store.calibration_margin_for(_calibration_budget()) == 0
    assert not store.calibration_path.exists()
    store.calibration_path.parent.mkdir(parents=True)
    store.calibration_path.write_text(contents, "utf-8")

    # When
    margin = store.calibration_margin_for(_calibration_budget())

    # Then
    assert margin == 0
    assert store.calibration_path.read_text("utf-8") == contents


def test_calibration_atomic_updates_preserve_other_keys_across_reload(tmp_path: Path) -> None:
    # Given
    settings_path = tmp_path / "settings" / "model.json"
    store = ModelSettingsStore(settings_path)
    first = _calibration_budget()
    second = _calibration_budget("https://provider.example:8443", "model-b")
    store.record_calibration_residual(first, 11)

    # When
    store.record_calibration_residual(second, 22)
    reloaded = ModelSettingsStore(settings_path)

    # Then
    assert reloaded.calibration_margin_for(first) == 11
    assert reloaded.calibration_margin_for(second) == 22


def test_calibration_replace_failure_preserves_existing_contents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Given
    store = ModelSettingsStore(tmp_path / "settings" / "model.json")
    budget = _calibration_budget()
    store.record_calibration_residual(budget, 11)
    existing_contents = store.calibration_path.read_text("utf-8")

    def fail_replace(source: Path, destination: Path) -> None:
        raise OSError(f"cannot replace {source} with {destination}")

    monkeypatch.setattr(model_settings.os, "replace", fail_replace)

    # When / Then
    with pytest.raises(OSError, match="cannot replace"):
        store.record_calibration_residual(budget, 22)
    assert store.calibration_path.read_text("utf-8") == existing_contents


def test_invalid_utf8_calibration_file_returns_zero_and_preserves_bytes(
    tmp_path: Path,
) -> None:
    """I2: A calibration file containing invalid UTF-8 bytes must return
    margin zero and preserve the file byte-for-byte."""
    store = ModelSettingsStore(tmp_path / "settings" / "model.json")
    store.calibration_path.parent.mkdir(parents=True, exist_ok=True)
    corrupted = b"\x80\x81\x82not valid utf-8"
    store.calibration_path.write_bytes(corrupted)

    # When
    margin = store.calibration_margin_for(_calibration_budget())

    # Then
    assert margin == 0
    assert store.calibration_path.read_bytes() == corrupted
