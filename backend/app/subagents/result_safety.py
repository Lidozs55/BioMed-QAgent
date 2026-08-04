"""Deterministic redaction and size limits for new child terminal results."""

from __future__ import annotations

from collections.abc import Iterable

from app.domain.contracts import SubagentResult
from app.recipes.redaction import REDACTED, redact_secrets

SUMMARY_MAX_CHARS = 4_096
ERROR_MAX_CHARS = 1_024
WARNING_MAX_CHARS = 512
WARNING_MAX_COUNT = 20
_TRUNCATED = "...[truncated]"


def _safe_text(
    value: str,
    *,
    limit: int,
    known_secrets: tuple[str, ...],
) -> str:
    safe = value
    for secret in sorted(
        {secret for secret in known_secrets if secret},
        key=len,
        reverse=True,
    ):
        safe = safe.replace(secret, REDACTED)
    redacted = redact_secrets(safe)
    if not isinstance(redacted, str):
        raise TypeError("subagent result text redaction must return a string")
    if len(redacted) <= limit:
        return redacted
    return redacted[: limit - len(_TRUNCATED)] + _TRUNCATED


def sanitize_subagent_result(
    result: SubagentResult,
    *,
    known_secrets: Iterable[str] = (),
) -> SubagentResult:
    """Return a bounded, redacted copy suitable for events and parent context."""

    secrets = tuple(known_secrets)
    error_message = (
        _safe_text(
            result.error_message,
            limit=ERROR_MAX_CHARS,
            known_secrets=secrets,
        )
        if result.error_message is not None
        else None
    )
    return result.model_copy(
        update={
            "summary": _safe_text(
                result.summary,
                limit=SUMMARY_MAX_CHARS,
                known_secrets=secrets,
            ),
            "warnings": [
                _safe_text(
                    warning,
                    limit=WARNING_MAX_CHARS,
                    known_secrets=secrets,
                )
                for warning in result.warnings[:WARNING_MAX_COUNT]
            ],
            "error_message": error_message,
        }
    )
