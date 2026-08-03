"""Validation gate stage: validate staging package and publish artifacts.

This package splits the former monolithic ``validation.py`` into focused
submodules (checks_common, checks/, publish, package, runner). The public
API is re-exported here so callers (``pipeline.stages`` and
``pipeline.runner``) need no changes.

The private ``_validate_package`` and ``_publish_artifacts`` names are also
re-exported because existing tests import them directly; aliasing them here
keeps the split a pure structural refactoring.

``os`` and ``shutil`` are imported at package level so existing tests that
monkeypatch ``validation_module.os.replace`` / ``validation_module.shutil.rmtree``
still patch the same singleton module objects used by ``publish.py``.
"""
from __future__ import annotations

# os and shutil are imported at package level so existing tests that monkeypatch
# ``validation_module.os.replace`` / ``validation_module.shutil.rmtree`` patch
# the same singleton module objects used by ``publish.py``.
import os  # noqa: F401
import shutil  # noqa: F401

from app.pipeline.stages.validation.checks_common import (
    deterministic_sample as _deterministic_sample,
)

# _validate_package and _publish_artifacts are re-exported (private) so tests
# importing them directly from the package keep working after the split.
from app.pipeline.stages.validation.package import (  # noqa: F401
    _validate_package,
    validate_package,
)
from app.pipeline.stages.validation.publish import (  # noqa: F401
    _publish_artifacts,
    _write_publish_completed_marker,
    publish_artifacts,
)
from app.pipeline.stages.validation.runner import (
    _requires_full_lineage_validation,
    run_validation,
)

__all__ = [
    "_deterministic_sample",
    "_requires_full_lineage_validation",
    "publish_artifacts",
    "run_validation",
    "validate_package",
]
