"""Content hashing helpers for the build chain.

Streams files instead of loading them fully (ARCHITECTURE §3.5 keeps files as
the exchange format for GB-scale matrices) and always closes the handle.
"""

from __future__ import annotations

import hashlib
from pathlib import Path


def sha256_file(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()
