"""User-selectable databases — thin declarative store (Phase 2)."""

from __future__ import annotations

from app.databases.declarative import (
    DatabaseValidationError,
    DeclarativeDatabaseManifest,
    DeclarativeHttpToolBuilder,
    HttpAuthReference,
    HttpOperationManifest,
    parse_manifest_document,
    validate_declarative_manifest,
)
from app.databases.store import DatabaseEntry, DatabaseStore

__all__ = [
    "DatabaseEntry",
    "DatabaseStore",
    "DatabaseValidationError",
    "DeclarativeDatabaseManifest",
    "DeclarativeHttpToolBuilder",
    "HttpAuthReference",
    "HttpOperationManifest",
    "parse_manifest_document",
    "validate_declarative_manifest",
]
