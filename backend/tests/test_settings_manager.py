"""Runtime user-settings persistence tests."""
from __future__ import annotations

from pathlib import Path

import pytest
from app import settings_manager
from app.model_config import UserSettings


@pytest.fixture
def settings_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Isolate the module singleton and settings-file seam for each test."""
    path = tmp_path / "user_settings.json"
    monkeypatch.setattr(settings_manager, "_SETTINGS_PATH", path)
    monkeypatch.setattr(settings_manager, "_runtime_settings", None)
    return path


def test_get_settings_prefers_persisted_values_over_environment(
    settings_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    persisted = UserSettings(
        base_url="https://saved.example/v1",
        api_key="saved-key",
        model_name="qwen-turbo",
    )
    settings_path.write_text(persisted.model_dump_json(), encoding="utf-8")
    monkeypatch.setenv("DASHSCOPE_BASE_URL", "https://environment.example/v1")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "environment-key")
    monkeypatch.setenv("MODEL_NAME", "qwen-max")

    # When
    loaded = settings_manager.get_settings()

    # Then
    assert loaded == persisted


def test_get_settings_uses_environment_only_for_empty_persisted_fields(
    settings_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    settings_path.write_text(
        UserSettings(base_url="", api_key="", model_name="qwen-plus").model_dump_json(),
        encoding="utf-8",
    )
    monkeypatch.setenv("DASHSCOPE_BASE_URL", "https://environment.example/v1")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "environment-key")
    monkeypatch.setenv("MODEL_NAME", "qwen-max")

    # When
    loaded = settings_manager.get_settings()

    # Then
    assert loaded.base_url == "https://environment.example/v1"
    assert loaded.api_key == "environment-key"
    assert loaded.model_name == "qwen-plus"


def test_update_settings_preserves_file_and_cache_when_atomic_replace_fails(
    settings_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    persisted = UserSettings(api_key="old-key", model_name="qwen-turbo")
    requested = UserSettings(api_key="new-key", model_name="qwen-max")
    settings_path.write_text(persisted.model_dump_json(), encoding="utf-8")
    monkeypatch.setattr(settings_manager, "_runtime_settings", persisted)

    def fail_replace(source: Path, destination: Path) -> None:
        raise OSError(f"cannot replace {source} with {destination}")

    monkeypatch.setattr(settings_manager.os, "replace", fail_replace)

    # When / Then
    with pytest.raises(OSError, match="cannot replace"):
        settings_manager.update_settings(requested)

    assert settings_path.read_text(encoding="utf-8") == persisted.model_dump_json()
    assert settings_manager.get_settings() is persisted


def test_update_settings_replaces_sibling_temp_file_before_publishing_cache(
    settings_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    persisted = UserSettings(api_key="old-key", model_name="qwen-turbo")
    requested = UserSettings(api_key="new-key", model_name="qwen-max")
    settings_path.write_text(persisted.model_dump_json(), encoding="utf-8")
    monkeypatch.setattr(settings_manager, "_runtime_settings", persisted)
    original_replace = settings_manager.os.replace
    fsync_calls: list[int] = []
    replacements: list[tuple[Path, Path]] = []

    def record_fsync(file_descriptor: int) -> None:
        fsync_calls.append(file_descriptor)

    def record_replace(source: Path, destination: Path) -> None:
        replacements.append((Path(source), Path(destination)))
        assert settings_manager.get_settings() is persisted
        original_replace(source, destination)

    monkeypatch.setattr(settings_manager.os, "fsync", record_fsync)
    monkeypatch.setattr(settings_manager.os, "replace", record_replace)

    # When
    saved = settings_manager.update_settings(requested)

    # Then
    assert fsync_calls
    assert replacements == [(replacements[0][0], settings_path)]
    assert replacements[0][0].parent == settings_path.parent
    assert replacements[0][0] != settings_path
    assert saved is requested
    assert settings_manager.get_settings() is requested
    assert UserSettings.model_validate_json(settings_path.read_text(encoding="utf-8")) == requested
