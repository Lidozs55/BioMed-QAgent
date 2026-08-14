"""Unit tests for ``database.declarative`` manifest validation.

Phase 8 stdlib reimplementation of the retired Pydantic models. The rules
pinned here mirror ``server/src/agent/tools/declarative-db.ts``
``parseDeclarativeManifest`` so the Python persistence boundary and the TS
tool builder cannot drift.
"""

from __future__ import annotations

import pytest
from database.declarative import (
    DatabaseValidationError,
    DeclarativeDatabaseManifest,
    HttpOperationManifest,
    redact_sensitive_manifest,
)


def _manifest(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "schema_version": "1.0",
        "name": "demo",
        "display_name": "Demo DB",
        "version": "1.0.0",
        "category": "discovery",
        "description": "demo declarative database",
        "supported_sources": ["demo"],
        "operations": [
            {
                "name": "search",
                "description": "Search",
                "method": "POST",
                "url": "https://example.com/search/{query}",
                "query": {"q": "{query}"},
                "headers": {},
                "body": None,
                "timeout_seconds": 30,
                "auth": None,
                "extract": None,
            },
        ],
        "enabled": True,
        "user_selectable": True,
        "pipeline_supported": False,
        "requirements": [],
    }
    base.update(overrides)
    return base


def test_valid_manifest_round_trip() -> None:
    manifest = DeclarativeDatabaseManifest.parse(_manifest())
    dumped = manifest.to_dict()
    assert dumped["name"] == "demo"
    assert dumped["operations"][0]["method"] == "POST"
    assert dumped["operations"][0]["timeout_seconds"] == 30
    assert dumped["pipeline_supported"] is False
    # round-trip: dump → parse → identical dump
    assert DeclarativeDatabaseManifest.parse(dumped).to_dict() == dumped


def test_schema_version_must_be_1_0() -> None:
    with pytest.raises(DatabaseValidationError, match="schema_version"):
        DeclarativeDatabaseManifest.parse(_manifest(schema_version="2.0"))


def test_unknown_manifest_keys_rejected() -> None:
    with pytest.raises(DatabaseValidationError, match="extra fields"):
        DeclarativeDatabaseManifest.parse(_manifest(extra_key="x"))


def test_name_must_match_pattern() -> None:
    with pytest.raises(DatabaseValidationError, match="name must match"):
        DeclarativeDatabaseManifest.parse(_manifest(name="Bad-Name"))


def test_display_name_version_description_required() -> None:
    with pytest.raises(DatabaseValidationError):
        DeclarativeDatabaseManifest.parse(_manifest(display_name=""))
    with pytest.raises(DatabaseValidationError):
        DeclarativeDatabaseManifest.parse(_manifest(version=""))
    with pytest.raises(DatabaseValidationError):
        DeclarativeDatabaseManifest.parse(_manifest(description=""))


def test_category_must_be_valid() -> None:
    with pytest.raises(DatabaseValidationError, match="category"):
        DeclarativeDatabaseManifest.parse(_manifest(category="research"))


def test_operation_names_must_be_unique() -> None:
    operation = _manifest()["operations"][0]
    with pytest.raises(DatabaseValidationError, match="unique"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[operation, operation])
        )


def test_pipeline_supported_must_be_false() -> None:
    with pytest.raises(DatabaseValidationError, match="pipeline_supported"):
        DeclarativeDatabaseManifest.parse(_manifest(pipeline_supported=True))


def test_requirements_must_be_empty() -> None:
    with pytest.raises(DatabaseValidationError, match="requirements"):
        DeclarativeDatabaseManifest.parse(_manifest(requirements=["numpy"]))


def test_operation_name_must_match_pattern() -> None:
    operation = _manifest()["operations"][0]
    with pytest.raises(DatabaseValidationError, match="operations\\[0\\].name"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[{**operation, "name": "Bad-Name"}])
        )


def test_operation_method_enum() -> None:
    operation = _manifest()["operations"][0]
    with pytest.raises(DatabaseValidationError, match="method"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[{**operation, "method": "FETCH"}])
        )


def test_operation_url_template_validation() -> None:
    operation = _manifest()["operations"][0]
    # relative URL rejected
    with pytest.raises(DatabaseValidationError, match="absolute HTTP"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[{**operation, "url": "/search/{query}"}])
        )
    # placeholder in authority rejected
    with pytest.raises(DatabaseValidationError, match="authority"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[{**operation, "url": "https://{host}/search"}])
        )
    # credentials rejected
    with pytest.raises(DatabaseValidationError, match="credentials"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[{**operation, "url": "https://user:pw@example.com/x"}])
        )
    # localhost rejected
    with pytest.raises(DatabaseValidationError, match="public hostname"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[{**operation, "url": "http://localhost:8000/x"}])
        )


def test_operation_timeout_range() -> None:
    operation = _manifest()["operations"][0]
    with pytest.raises(DatabaseValidationError, match="timeout_seconds"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[{**operation, "timeout_seconds": 0}])
        )
    with pytest.raises(DatabaseValidationError, match="timeout_seconds"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[{**operation, "timeout_seconds": 121}])
        )


def test_operation_headers_must_be_fixed_names() -> None:
    operation = _manifest()["operations"][0]
    with pytest.raises(DatabaseValidationError, match="header names"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[{**operation, "headers": {"X-{dynamic}": "1"}}])
        )
    with pytest.raises(DatabaseValidationError, match="header names"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[{**operation, "headers": {"X-Bad\r\n": "1"}}])
        )


def test_operation_extract_path() -> None:
    operation = _manifest()["operations"][0]
    with pytest.raises(DatabaseValidationError, match="extract"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[{**operation, "extract": "bad path!"}])
        )


def test_auth_reference_validation() -> None:
    operation = _manifest()["operations"][0]
    with pytest.raises(DatabaseValidationError, match="auth"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[{**operation, "auth": {"source": "file"}}])
        )
    with pytest.raises(DatabaseValidationError, match="auth.reference"):
        DeclarativeDatabaseManifest.parse(
            _manifest(operations=[{
                **operation,
                "auth": {"source": "env", "reference": "bad-ref", "location": "header", "name": "X"},
            }])
        )
    valid = DeclarativeDatabaseManifest.parse(
        _manifest(operations=[{
            **operation,
            "auth": {
                "source": "env",
                "reference": "BIOMED_SKILL_SECRET_DEMO",
                "location": "header",
                "name": "X-Api-Key",
                "prefix": "Bearer ",
            },
        }])
    )
    auth = valid.operations[0].auth
    assert auth is not None
    assert auth.reference == "BIOMED_SKILL_SECRET_DEMO"
    assert auth.prefix == "Bearer "


def test_boolean_coercion() -> None:
    assert DeclarativeDatabaseManifest.parse(_manifest(enabled="true")).enabled is True
    assert DeclarativeDatabaseManifest.parse(_manifest(enabled=0)).enabled is False
    with pytest.raises(DatabaseValidationError, match="boolean"):
        DeclarativeDatabaseManifest.parse(_manifest(enabled="yes"))


def test_empty_operations_allowed() -> None:
    manifest = DeclarativeDatabaseManifest.parse(_manifest(operations=[]))
    assert manifest.operations == ()


def test_redact_sensitive_manifest() -> None:
    value = {
        "authorization": "secret",
        "headers": {"X-Api-Key": "k", "X-Other": "o"},
        "nested": {"api_key": "v"},
    }
    redacted = redact_sensitive_manifest(value)
    assert redacted["authorization"] == "[redacted]"
    assert redacted["headers"]["X-Api-Key"] == "[redacted]"
    assert redacted["headers"]["X-Other"] == "o"
    assert redacted["nested"]["api_key"] == "[redacted]"


def test_http_operation_manifest_to_dict_round_trip() -> None:
    operation = HttpOperationManifest.parse(_manifest()["operations"][0], 0)
    assert operation.to_dict()["query"] == {"q": "{query}"}
    assert operation.to_dict()["auth"] is None
