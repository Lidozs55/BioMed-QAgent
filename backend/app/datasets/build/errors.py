"""Shared failure types for the dataset build chain (Phase 3).

The chain is composed of pure, deterministic stages.  Execution failures
(parse/checksum/integrate errors) raise these types; the compatibility gate
and validation profile report structured rejections instead of raising.
"""

from __future__ import annotations


class BuildError(ValueError):
    """Base class for a failed dataset build step."""


class AdapterError(BuildError):
    """A source could not be parsed (malformed input, checksum mismatch)."""


class EmptySourceError(AdapterError):
    """A source file parsed to zero data rows (header-only input).

    H3 (Phase 4 review): empty-source detection is structured — the typed
    error carries ``reason_code="no_primary_data"`` which the executor
    propagates into the outcome error details so the tool never has to
    substring-match error text.
    """

    reason_code: str = "no_primary_data"


class IntegratorError(BuildError):
    """The merge strategy or merge inputs are invalid."""
