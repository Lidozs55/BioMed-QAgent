"""Content-addressed cache path definitions for verified download bytes."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _canonical_sha256(value: str) -> str:
    checksum = value.strip().lower()
    if not _SHA256.fullmatch(checksum):
        raise ValueError("SHA-256 must contain exactly 64 hexadecimal characters")
    return checksum


@dataclass(frozen=True)
class ContentCache:
    """Resolve cache paths without treating free-text queries as cache keys."""

    root: Path

    def blob_path(self, sha256: str) -> Path:
        checksum = _canonical_sha256(sha256)
        parent = self.root / "blobs" / "sha256" / checksum[:2] / checksum[2:4]
        parent.mkdir(parents=True, exist_ok=True)
        return parent / checksum

    def metadata_path(self, canonical_request_hash: str) -> Path:
        request_hash = _canonical_sha256(canonical_request_hash)
        parent = self.root / "metadata"
        parent.mkdir(parents=True, exist_ok=True)
        return parent / f"{request_hash}.json"
