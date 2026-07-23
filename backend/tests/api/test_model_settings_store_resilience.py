"""Task 5 review fixes — store boundary resilience: malformed persisted
JSON fallback and caller input non-mutation."""

from __future__ import annotations

import contextlib
from pathlib import Path

from app.config import Settings


def test_load_falls_back_to_defaults_on_cross_field_invalid_ratios(
    tmp_path: Path,
) -> None:
    """I-1: Persisted JSON with target >= trigger must not cause GET 500.
    The store must fall back to configured defaults without rewriting the
    invalid file."""
    from app.model_settings import ModelSettingsStore

    settings_path = tmp_path / "settings" / "model.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(
        """\
{
  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "api_key": "",
  "model_name": "qwen-max",
  "max_tokens": 4096,
  "context_window": null,
  "safety_reserve_ratio": 0.05,
  "compaction_trigger_ratio": 0.60,
  "compaction_target_ratio": 0.80,
  "advanced": {
    "temperature": 0.7,
    "top_p": 1.0,
    "repetition_penalty": 1.0,
    "enable_search": false,
    "thinking_mode": false
  }
}
""",
        encoding="utf-8",
    )
    defaults = Settings(
        dashscope_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        dashscope_api_key="default-key",
        model_name="qwen-plus",
    )
    store = ModelSettingsStore(settings_path, defaults=defaults)

    config = store.snapshot()
    assert config.model_name == defaults.model_name
    assert config.api_key == defaults.dashscope_api_key
    raw = settings_path.read_text("utf-8")
    assert '"compaction_target_ratio": 0.80' in raw


def test_load_falls_back_to_defaults_on_non_positive_capacity(
    tmp_path: Path,
) -> None:
    """I-1: Persisted config whose resolved input capacity is non-positive
    must fall back to defaults without rewriting the file."""
    from app.model_settings import ModelSettingsStore

    settings_path = tmp_path / "settings" / "model.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(
        """\
{
  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "api_key": "",
  "model_name": "qwen-max",
  "max_tokens": 32768,
  "context_window": null,
  "safety_reserve_ratio": 0.05,
  "compaction_trigger_ratio": 0.85,
  "compaction_target_ratio": 0.60,
  "advanced": {
    "temperature": 0.7,
    "top_p": 1.0,
    "repetition_penalty": 1.0,
    "enable_search": false,
    "thinking_mode": false
  }
}
""",
        encoding="utf-8",
    )
    defaults = Settings(
        dashscope_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwen-plus",
    )
    store = ModelSettingsStore(settings_path, defaults=defaults)

    config = store.snapshot()
    assert config.model_name == defaults.model_name
    assert config.max_tokens == 8192
    raw = settings_path.read_text("utf-8")
    assert '"max_tokens": 32768' in raw


def test_update_does_not_mutate_caller_changes_dict(tmp_path: Path) -> None:
    """I-2: The ``changes`` dict passed to ``update()`` must remain equal
    after both successful and rejected updates."""
    from app.model_settings import ModelSettingsStore

    store = ModelSettingsStore(
        tmp_path / "model.json",
        defaults=Settings(
            dashscope_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
            model_name="qwen-max",
        ),
    )
    store.update({"max_tokens": 4096})

    # Successful update — caller dict must be unchanged
    changes = {"temperature": 0.2, "max_tokens": 2048}
    original = dict(changes)
    store.update(changes)
    assert changes == original, "caller dict mutated after successful update"

    # Rejected update — caller dict must be unchanged
    bad_changes = {
        "compaction_target_ratio": 0.90,
        "compaction_trigger_ratio": 0.80,
    }
    bad_original = dict(bad_changes)
    with contextlib.suppress(ValueError):
        store.update(bad_changes)
    assert bad_changes == bad_original, "caller dict mutated after rejected update"
