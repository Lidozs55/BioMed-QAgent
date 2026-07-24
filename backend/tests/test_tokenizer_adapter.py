"""Optional local tokenizer boundary tests."""

from __future__ import annotations

import builtins
import socket
import sys
import urllib.request
from types import ModuleType

import pytest
from app.model_config.token_estimation import (
    ConservativeUtf8TokenCounter,
    DashScopeLocalTokenizerAdapter,
    TextTokenCounter,
    select_text_token_counter,
)


class CountingTokenizer:
    def encode(self, text: str) -> list[int]:
        return [0] * len(text.split())


def test_select_text_token_counter_falls_back_when_real_dashscope_rejects_qwq_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    pytest.importorskip("dashscope")
    from dashscope.common.error import UnsupportedModel

    def reject_qwq(_: str) -> CountingTokenizer:
        raise UnsupportedModel("not supported")

    monkeypatch.setattr("dashscope.get_tokenizer", reject_qwq)

    # When
    counter = select_text_token_counter(
        provider_origin="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwq-32b",
    )

    # Then
    assert isinstance(counter, ConservativeUtf8TokenCounter)


def test_select_text_token_counter_falls_back_when_dashscope_import_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    import_module = builtins.__import__

    def reject_dashscope_import(name, *args, **kwargs):
        if name == "dashscope" or name.startswith("dashscope."):
            raise ModuleNotFoundError("dashscope optional extra is unavailable")
        return import_module(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", reject_dashscope_import)

    # When
    counter = select_text_token_counter(
        provider_origin="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwen-plus",
    )

    # Then
    assert isinstance(counter, ConservativeUtf8TokenCounter)


def test_default_dashscope_adapter_uses_only_local_get_tokenizer_and_encode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    calls: list[tuple[str, str]] = []

    class FakeTokenizer:
        def encode(self, text: str) -> list[int]:
            calls.append(("encode", text))
            return [1, 2]

    class UnsupportedModel(Exception):
        pass

    def get_tokenizer(model_name: str) -> FakeTokenizer:
        calls.append(("get_tokenizer", model_name))
        if model_name == "qwq-32b":
            raise UnsupportedModel("not supported")
        return FakeTokenizer()

    def fail_remote(*args, **kwargs):
        raise AssertionError("local tokenizer initialization must not access the network")

    class RemoteClient:
        def __init__(self, *args, **kwargs) -> None:
            fail_remote(*args, **kwargs)

        def __getattr__(self, _: str):
            return fail_remote

    class Tokenization:
        @staticmethod
        def call(*args, **kwargs):
            raise AssertionError("production token estimation must not call Tokenization.call")

    def install_http_module(module_name: str) -> None:
        module = ModuleType(module_name)
        module.get = fail_remote
        module.post = fail_remote
        module.put = fail_remote
        module.patch = fail_remote
        module.delete = fail_remote
        module.request = fail_remote
        module.Session = RemoteClient
        module.Client = RemoteClient
        module.AsyncClient = RemoteClient
        module.ClientSession = RemoteClient
        monkeypatch.setitem(sys.modules, module_name, module)

    dashscope_module = ModuleType("dashscope")
    dashscope_module.get_tokenizer = get_tokenizer
    dashscope_module.Tokenization = Tokenization
    common_module = ModuleType("dashscope.common")
    error_module = ModuleType("dashscope.common.error")
    error_module.UnsupportedModel = UnsupportedModel
    monkeypatch.setitem(sys.modules, "dashscope", dashscope_module)
    monkeypatch.setitem(sys.modules, "dashscope.common", common_module)
    monkeypatch.setitem(sys.modules, "dashscope.common.error", error_module)
    install_http_module("requests")
    install_http_module("httpx")
    install_http_module("aiohttp")
    huggingface_hub_module = ModuleType("huggingface_hub")
    huggingface_hub_module.hf_hub_download = fail_remote
    huggingface_hub_module.snapshot_download = fail_remote
    huggingface_hub_module.cached_download = fail_remote
    huggingface_hub_module.__path__ = []
    huggingface_file_download_module = ModuleType("huggingface_hub.file_download")
    huggingface_file_download_module.hf_hub_download = fail_remote
    huggingface_file_download_module.snapshot_download = fail_remote
    monkeypatch.setitem(sys.modules, "huggingface_hub", huggingface_hub_module)
    monkeypatch.setitem(sys.modules, "huggingface_hub.file_download", huggingface_file_download_module)
    transformers_module = ModuleType("transformers")
    transformers_module.AutoTokenizer = RemoteClient
    monkeypatch.setitem(sys.modules, "transformers", transformers_module)
    monkeypatch.setattr(socket, "create_connection", fail_remote)
    monkeypatch.setattr(socket.socket, "connect", fail_remote)
    monkeypatch.setattr(urllib.request, "urlopen", fail_remote)
    monkeypatch.setattr(urllib.request, "urlretrieve", fail_remote)

    # When
    counter = select_text_token_counter(
        provider_origin="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwen-plus",
    )
    token_count = counter.count("local text")
    unsupported_counter = select_text_token_counter(
        provider_origin="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwq-32b",
    )

    # Then
    assert token_count == 2
    assert isinstance(unsupported_counter, ConservativeUtf8TokenCounter)
    assert calls == [
        ("get_tokenizer", "qwen-plus"),
        ("encode", "local text"),
        ("get_tokenizer", "qwq-32b"),
    ]


def test_select_text_token_counter_uses_conservative_fallback_by_default() -> None:
    # Given
    calls: list[str] = []

    def unexpected_factory(model_name: str) -> CountingTokenizer:
        calls.append(model_name)
        raise AssertionError("non-DashScope models must not initialize a local tokenizer")

    # When
    counter = select_text_token_counter(
        provider_origin="https://api.example/v1",
        model_name="compatible-model",
        tokenizer_factory=unexpected_factory,
    )

    # Then
    assert isinstance(counter, ConservativeUtf8TokenCounter)
    assert calls == []
    assert counter.count("") == 0
    assert counter.count("A中") == len("A中".encode())


def test_dashscope_local_tokenizer_adapter_counts_with_injected_official_tokenizer() -> None:
    # Given
    tokenizer = CountingTokenizer()

    # When
    adapter = DashScopeLocalTokenizerAdapter.try_create(
        "qwen-plus",
        tokenizer_factory=lambda _: tokenizer,
    )

    # Then
    assert adapter is not None
    assert adapter.count("one two three") == 3


def test_select_text_token_counter_falls_back_when_optional_support_is_missing() -> None:
    # Given
    def missing_optional_support(_: str) -> CountingTokenizer:
        raise ModuleNotFoundError("dashscope tokenizer extra is unavailable")

    # When
    counter = select_text_token_counter(
        provider_origin="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwen-plus",
        tokenizer_factory=missing_optional_support,
    )

    # Then
    assert isinstance(counter, ConservativeUtf8TokenCounter)


def test_select_text_token_counter_falls_back_when_model_is_unsupported() -> None:
    # Given
    def unsupported_model(_: str) -> TextTokenCounter:
        raise ValueError("unsupported model")

    # When
    counter = select_text_token_counter(
        provider_origin="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwen-unsupported",
        tokenizer_factory=unsupported_model,
    )

    # Then
    assert isinstance(counter, ConservativeUtf8TokenCounter)
