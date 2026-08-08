"""Shared failure types for the dataset build chain (Phase 3).

The chain is composed of pure, deterministic stages.  Execution failures
(parse/checksum/integrate errors) raise these types; the compatibility gate
and validation profile report structured rejections instead of raising.
"""

from __future__ import annotations

from app.datasets.contracts import BindingRejection


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


class BindingRejectedError(BuildError):
    """One source binding is rejected during phase A (Phase 5 T7 D5).

    Raised by the runner when a binding canonicalized to zero usable rows
    (or, for gene-required builds, to zero publishable gene rows) after its
    parse succeeded.  The executor catches it per-binding — the binding's
    remaining phase-A operations are skipped and phase B only receives the
    bindings that did not raise.
    """

    def __init__(self, rejection: BindingRejection) -> None:
        self.rejection = rejection
        super().__init__(rejection.message or rejection.reason_code)


class IntegratorError(BuildError):
    """The merge strategy or merge inputs are invalid."""
