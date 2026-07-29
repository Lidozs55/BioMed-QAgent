from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from app.domain.contracts import (
    ApiRequestStep,
    BrowserActionStep,
    HtmlExtractStep,
    RecipeAttempt,
    RecipeStatus,
    WorkflowRecipe,
)
from pydantic import TypeAdapter, ValidationError

NOW = datetime(2026, 7, 29, tzinfo=UTC)


def test_recipe_step_union_is_discriminated_by_type() -> None:
    adapter = TypeAdapter(WorkflowRecipe.model_fields["steps"].annotation)

    steps = adapter.validate_python(
        [
            {
                "type": "api_request",
                "url_template": "https://api.example.org/{accession}",
            },
            {
                "type": "html_extract",
                "url_template": "https://example.org/{accession}",
                "selectors": {"download": "a.download"},
            },
            {
                "type": "browser_action",
                "action": "click",
                "target": "a.download",
            },
        ]
    )

    assert isinstance(steps[0], ApiRequestStep)
    assert isinstance(steps[1], HtmlExtractStep)
    assert isinstance(steps[2], BrowserActionStep)


@pytest.mark.parametrize(
    "action",
    ["navigate", "click", "fill", "select", "wait_for", "extract"],
)
def test_browser_action_allowlist_accepts_declared_actions(action: str) -> None:
    step = BrowserActionStep(type="browser_action", action=action)

    assert step.action == action


def test_browser_action_rejects_executable_script_action() -> None:
    with pytest.raises(ValidationError):
        BrowserActionStep(
            type="browser_action",
            action="evaluate",
            value="window.localStorage",
        )


def test_recipe_contract_rejects_url_userinfo_in_step() -> None:
    with pytest.raises(ValidationError, match="userinfo"):
        ApiRequestStep(
            type="api_request",
            url_template="https://alice:supersecret@example.org/data",
        )


def test_recipe_contract_rejects_url_userinfo_in_attempt() -> None:
    with pytest.raises(ValidationError, match="userinfo"):
        RecipeAttempt(
            method="api",
            url="https://alice:supersecret@example.org/data",
            status="failed",
            started_at=NOW,
            finished_at=NOW,
            reason="request failed",
        )


def test_recipe_contract_rejects_url_userinfo_in_generic_fields() -> None:
    data = _recipe().model_dump(mode="json")
    data["input_schema"] = {
        "type": "object",
        "examples": ["https://alice:supersecret@example.org/data"],
    }

    with pytest.raises(ValidationError, match="userinfo"):
        WorkflowRecipe.model_validate(data)


def test_recipe_contract_rejects_arbitrary_code_fields() -> None:
    with pytest.raises(ValidationError):
        WorkflowRecipe.model_validate(
            {
                **_recipe().model_dump(mode="json"),
                "code": "import os",
            }
        )


def test_recipe_contract_rejects_nested_executable_fields() -> None:
    with pytest.raises(ValidationError, match="executable"):
        WorkflowRecipe.model_validate(
            {
                **_recipe().model_dump(mode="json"),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "payload": {
                            "type": "object",
                            "code": "import os",
                        }
                    },
                },
            }
        )


@pytest.mark.parametrize(
    "field_name",
    [
        "python_code",
        "script_body",
        "javascript_payload",
        "shell_command",
        "generatedSourceCode",
        "pythoncode",
        "scriptbody",
        "javascriptpayload",
        "shellcommand",
        "generatedsourcecode",
    ],
)
def test_recipe_contract_rejects_executable_alias_fields(field_name: str) -> None:
    data = _recipe().model_dump(mode="json")
    data["input_schema"] = {
        "type": "object",
        "properties": {
            "outer": {
                "type": "object",
                "properties": {
                    "payload": {
                        field_name: "malicious instructions",
                    }
                },
            }
        },
    }

    with pytest.raises(ValidationError, match="executable"):
        WorkflowRecipe.model_validate(data)


@pytest.mark.parametrize("field_name", ["status_code", "statuscode", "transcript"])
def test_recipe_contract_allows_non_executable_compact_fields(
    field_name: str,
) -> None:
    data = _recipe().model_dump(mode="json")
    data["input_schema"] = {
        "type": "object",
        "metadata": {field_name: "plain metadata"},
    }

    validated = WorkflowRecipe.model_validate(data)

    assert validated.input_schema["metadata"][field_name] == "plain metadata"


def test_recipe_contract_preserves_legitimate_status_code_field() -> None:
    recipe = _recipe().model_copy(
        update={
            "attempts": [
                RecipeAttempt(
                    method="api",
                    url="https://api.example.org/data",
                    status="failed",
                    started_at=NOW,
                    finished_at=NOW,
                    status_code=503,
                    reason="service unavailable",
                )
            ]
        }
    )

    validated = WorkflowRecipe.model_validate(recipe.model_dump(mode="json"))

    assert validated.attempts[0].status_code == 503


@pytest.mark.parametrize(
    ("status", "updates"),
    [
        ("draft", {"verified_at": NOW}),
        ("draft", {"promotion_requested_at": NOW}),
        ("draft", {"last_succeeded_at": NOW}),
        ("verified", {"verified_at": NOW, "promoted_at": NOW}),
        ("verified", {"verified_at": NOW, "rejected_at": NOW}),
        (
            "promoted",
            {
                "verified_at": NOW,
                "promotion_requested_at": NOW,
                "promoted_at": NOW,
                "rejected_at": NOW,
            },
        ),
        (
            "rejected",
            {
                "rejected_at": NOW,
                "rejection_reason": "rejected",
                "promoted_at": NOW,
            },
        ),
    ],
)
def test_recipe_contract_rejects_lifecycle_fields_for_wrong_status(
    status: str,
    updates: dict[str, object],
) -> None:
    data = _recipe().model_dump(mode="json")
    data.update({"status": status, **updates})

    with pytest.raises(ValidationError, match="lifecycle|timestamp"):
        WorkflowRecipe.model_validate(data)


@pytest.mark.parametrize(
    ("status", "updates"),
    [
        ("verified", {"verified_at": NOW - timedelta(seconds=1)}),
        (
            "verified",
            {
                "verified_at": NOW,
                "promotion_requested_at": NOW - timedelta(seconds=1),
            },
        ),
        (
            "promoted",
            {
                "verified_at": NOW,
                "promotion_requested_at": NOW + timedelta(seconds=2),
                "promoted_at": NOW + timedelta(seconds=1),
            },
        ),
        (
            "rejected",
            {
                "verified_at": NOW,
                "rejected_at": NOW - timedelta(seconds=1),
                "rejection_reason": "rejected",
            },
        ),
        (
            "verified",
            {
                "verified_at": NOW,
                "last_succeeded_at": NOW - timedelta(seconds=1),
            },
        ),
        (
            "verified",
            {
                "verified_at": NOW,
                "last_succeeded_at": NOW + timedelta(seconds=1),
            },
        ),
    ],
)
def test_recipe_contract_rejects_out_of_order_lifecycle_timestamps(
    status: str,
    updates: dict[str, object],
) -> None:
    data = _recipe().model_dump(mode="json")
    data.update({"status": status, **updates})

    with pytest.raises(ValidationError, match="precede|ordering"):
        WorkflowRecipe.model_validate(data)


def test_last_succeeded_at_requires_verified_at_for_rejected_recipe() -> None:
    data = _recipe().model_dump(mode="json")
    data.update(
        {
            "status": "rejected",
            "rejected_at": NOW,
            "rejection_reason": "validation rejected",
            "last_succeeded_at": NOW,
        }
    )

    with pytest.raises(ValidationError, match="last_succeeded_at.*verified_at"):
        WorkflowRecipe.model_validate(data)


def test_recipe_attempt_rejects_reversed_timestamps() -> None:
    with pytest.raises(ValidationError, match="finished_at"):
        RecipeAttempt(
            method="api",
            url="https://api.example.org/data",
            status="failed",
            started_at=NOW,
            finished_at=NOW - timedelta(seconds=1),
            reason="timeout",
        )


def _recipe() -> WorkflowRecipe:
    return WorkflowRecipe(
        recipe_id="recipe_geo",
        created_at=NOW,
        generated_by_model="qwen-plus",
        domain="gene-expression",
        capability="download-series-matrix",
        allowed_hosts=["api.example.org"],
        input_schema={
            "type": "object",
            "properties": {"accession": {"type": "string"}},
            "required": ["accession"],
        },
        steps=[
            ApiRequestStep(
                type="api_request",
                url_template="https://api.example.org/{accession}",
            )
        ],
        status=RecipeStatus.DRAFT,
    )
