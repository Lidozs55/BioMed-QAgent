"""Content-addressed cache path definitions for verified download bytes."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _canonical_sha256(value: str) -> str:
    checksum = value.strip().lower()
    if not _SHA256.fullmatch(checksum):
        raise ValueError("SHA-256 must contain exactly 64 hexadecimal characters")
    return checksum


def canonical_request_hash(
    database: str,
    accession: str,
    url: str,
) -> str:
    """Compute a deterministic SHA-256 from canonical request identity.

    The cache key uses ``(database, accession, url)`` — never free-text
    keywords alone — so identical source requests resolve to the same
    cached blob without re-downloading.
    """
    canonical = json.dumps(
        {
            "database": database.strip().lower(),
            "accession": accession.strip().lower(),
            "url": url.strip(),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


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

    def read_metadata(self, request_hash: str) -> dict[str, str] | None:
        """Return cached metadata for *request_hash* or ``None`` if absent."""
        path = self.metadata_path(request_hash)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        if not isinstance(data, dict) or "sha256" not in data:
            return None
        return data

    def write_metadata(self, request_hash: str, metadata: dict[str, str]) -> None:
        """Persist *metadata* for *request_hash* to the metadata directory."""
        path = self.metadata_path(request_hash)
        path.write_text(json.dumps(metadata, sort_keys=True) + "\n", "utf-8")
