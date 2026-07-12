"""配置测试 — 验证 Settings 加载和默认值。"""
from __future__ import annotations

from app.config import Settings, settings


def test_settings_has_dashscope_api_key() -> None:
    assert hasattr(settings, "dashscope_api_key")
    assert isinstance(settings.dashscope_api_key, str)


def test_settings_has_dashscope_base_url() -> None:
    assert hasattr(settings, "dashscope_base_url")
    assert "dashscope" in settings.dashscope_base_url or "compatible-mode" in settings.dashscope_base_url


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


def test_settings_is_frozen() -> None:
    """Settings 是 frozen dataclass，不可变。"""
    import pytest
    with pytest.raises(Exception):
        settings.host = "0.0.0.0"  # type: ignore[misc]
