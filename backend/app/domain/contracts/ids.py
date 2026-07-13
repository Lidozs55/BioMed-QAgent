"""Canonical identifier generation for persisted pipeline records."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any
from uuid import uuid4

from app.domain.contracts.enums import Database


_PREFIX_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def _canonical_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def generate_prefixed_uuid(prefix: str) -> str:
    """Return a lowercase UUID4 with a safe, stable type prefix."""

    if not _PREFIX_PATTERN.fullmatch(prefix):
        raise ValueError("prefix must contain lowercase letters, digits or underscores")
    return f"{prefix}_{uuid4()}"


def generate_task_id() -> str:
    return generate_prefixed_uuid("task")


def generate_run_id() -> str:
    return generate_prefixed_uuid("run")


def generate_message_id() -> str:
    return generate_prefixed_uuid("message")


def make_dataset_id(database: Database, accession: str) -> str:
    canonical_accession = accession.strip().lower()
    if not canonical_accession:
        raise ValueError("accession must not be blank")
    return f"ds_{database.value}_{canonical_accession}"


def make_source_id(database: Database, accession: str, url: str) -> str:
    canonical = {
        "accession": accession.strip().lower(),
        "database": database.value,
        "url": url.strip(),
    }
    if not canonical["accession"] or not canonical["url"]:
        raise ValueError("accession and url must not be blank")
    return f"src_{_canonical_digest(canonical)[:32]}"


def asset_id_from_sha256(sha256: str) -> str:
    checksum = sha256.strip().lower()
    if not _SHA256_PATTERN.fullmatch(checksum):
        raise ValueError("SHA-256 must contain exactly 64 hexadecimal characters")
    return f"asset_{checksum}"


def make_record_id(dataset_id: str, gene_id_raw: str, sample_id: str) -> str:
    values = [dataset_id, gene_id_raw, sample_id]
    if any(not value for value in values):
        raise ValueError("record ID components must not be blank")
    return f"rec_{_canonical_digest(values)[:32]}"
