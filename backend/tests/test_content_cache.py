from __future__ import annotations

from pathlib import Path

import pytest

from app.tools.content_cache import ContentCache


SHA256 = "abcdef" + "01" * 29
REQUEST_HASH = "12" * 32


def test_content_cache_uses_sha256_fanout_layout(tmp_path: Path) -> None:
    cache = ContentCache(tmp_path / "cache")

    assert cache.blob_path(SHA256) == (
        tmp_path / "cache" / "blobs" / "sha256" / "ab" / "cd" / SHA256
    )
    assert cache.blob_path(SHA256).parent.is_dir()


def test_content_cache_uses_canonical_request_metadata_path(tmp_path: Path) -> None:
    cache = ContentCache(tmp_path / "cache")

    assert cache.metadata_path(REQUEST_HASH) == (
        tmp_path / "cache" / "metadata" / f"{REQUEST_HASH}.json"
    )
    assert cache.metadata_path(REQUEST_HASH).parent.is_dir()


@pytest.mark.parametrize("checksum", ["", "xyz", "aa" * 31, "aa" * 33])
def test_content_cache_rejects_invalid_hashes(
    tmp_path: Path, checksum: str
) -> None:
    cache = ContentCache(tmp_path / "cache")

    with pytest.raises(ValueError, match="SHA-256"):
        cache.blob_path(checksum)
    with pytest.raises(ValueError, match="SHA-256"):
        cache.metadata_path(checksum)
