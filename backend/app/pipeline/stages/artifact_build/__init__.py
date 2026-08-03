"""Artifact builder stage: write staging CSV package from upstream outputs.

This package splits the former monolithic ``artifact_build.py`` into focused
submodules (columns, samples, warnings, relations, catalog, field_mapping,
cleaning, builder). The public API is re-exported here so callers
(``pipeline.stages`` and ``pipeline.runner``) need no changes.
"""
from __future__ import annotations

from app.pipeline.stages.artifact_build.builder import run_artifact_build

# Re-exported so tests importing ``_build_source_relations`` from the package
# keep working after the split (pure structural refactoring).
from app.pipeline.stages.artifact_build.relations import (  # noqa: F401
    _build_source_relations,
)

__all__ = ["run_artifact_build"]
