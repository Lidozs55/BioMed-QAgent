"""Typed internal dispatcher for declarative WorkflowRecipe lifecycle actions."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Annotated, Any, Literal, Self

from agents import FunctionTool, RunContextWrapper
from pydantic import Field, JsonValue, TypeAdapter, ValidationError, model_validator

from app.agent_loop.context import RunContext
from app.domain.contracts import RecipeStatus, WorkflowRecipe
from app.domain.contracts.base import ContractModel
from app.recipes.executor import RecipeExecutor
from app.recipes.redaction import redact_secrets
from app.recipes.store import WorkflowRecipeStore
from app.skills.registry import SkillCategory, SkillDef, skill_registry
from app.subagents.staging import SubagentStagingWorkspace


class DevelopWorkflowRequest(ContractModel):
    operation: Literal["develop_workflow"]
    recipe: WorkflowRecipe

    @model_validator(mode="after")
    def reject_credentials(self) -> Self:
        serialized = self.recipe.model_dump(mode="json")
        if redact_secrets(serialized) != serialized:
            raise ValueError("develop_workflow cannot contain credentials or secrets")
        return self


class ValidateRecipeRequest(ContractModel):
    operation: Literal["validate_recipe"]
    recipe_id: str = Field(min_length=1)
    version: int = Field(ge=1)
    inputs: dict[str, JsonValue] = Field(default_factory=dict)


class FindRecipeRequest(ContractModel):
    operation: Literal["find_recipe"]
    domain: str = Field(min_length=1)
    capability: str = Field(min_length=1)
    host: str | None = Field(default=None, min_length=1)


class RequestPromotionRequest(ContractModel):
    operation: Literal["request_promotion"]
    recipe_id: str = Field(min_length=1)


CreateSkillRequest = Annotated[
    DevelopWorkflowRequest | ValidateRecipeRequest | FindRecipeRequest | RequestPromotionRequest,
    Field(discriminator="operation"),
]
_REQUEST_ADAPTER = TypeAdapter(CreateSkillRequest)


@dataclass(frozen=True, slots=True)
class CreateSkillRuntime:
    """Run-bound trusted services that model arguments cannot replace."""

    store: WorkflowRecipeStore
    workspace: SubagentStagingWorkspace
    executor: RecipeExecutor | None = None


async def _invoke_create_skill(
    context: RunContextWrapper[Any],
    input_json: str,
) -> str:
    try:
        request = _REQUEST_ADAPTER.validate_json(input_json)
    except (ValidationError, ValueError):
        return _error(
            "invalid_recipe_input",
            "request did not match the declarative create_skill contract",
        )

    run_context: RunContext = context.context
    try:
        runtime = run_context.create_skill_runtime
        if isinstance(request, DevelopWorkflowRequest):
            result = _develop(run_context, runtime, request)
        elif isinstance(request, ValidateRecipeRequest):
            if runtime.executor is None:
                return _error(
                    "recipe_validation_unavailable",
                    "controlled Recipe validation is not available in this runtime",
                )
            result = await _validate(run_context, runtime, request)
        elif isinstance(request, FindRecipeRequest):
            result = _find(runtime, request)
        else:
            result = _request_promotion(runtime, request)
    except KeyError:
        return _error("recipe_not_found", "the requested WorkflowRecipe was not found")
    except (OSError, RuntimeError, ValueError) as error:
        return _error("create_skill_failed", str(error))
    return json.dumps(result, ensure_ascii=False)


def _develop(
    run_context: RunContext,
    runtime: CreateSkillRuntime,
    request: DevelopWorkflowRequest,
) -> dict[str, object]:
    recipe = request.recipe
    if recipe.status is not RecipeStatus.DRAFT:
        raise ValueError("develop_workflow accepts draft WorkflowRecipes only")
    with run_context.reserve_create_skill(recipe.domain, recipe.capability):
        stored = runtime.store.save_draft(recipe)
    run_context.record_recipe(stored.recipe_id)
    return _success(request.operation, recipe=_recipe_metadata(stored))


async def _validate(
    run_context: RunContext,
    runtime: CreateSkillRuntime,
    request: ValidateRecipeRequest,
) -> dict[str, object]:
    executor = runtime.executor
    assert executor is not None
    result = await executor.execute_for_validation(
        recipe_id=request.recipe_id,
        version=request.version,
        inputs=request.inputs,
        workspace=runtime.workspace,
    )
    runtime.workspace.validate_source_asset(result.source_asset)
    committed = runtime.workspace.commit_source_asset(result.source_asset)
    draft = runtime.store.get(request.recipe_id, request.version)
    evidence = [
        *draft.verification_evidence,
        f"source_asset:{committed.asset_id}:sha256:{committed.sha256}",
    ]
    verified = runtime.store.mark_verified(
        request.recipe_id,
        expected_version=request.version,
        attempts=[*draft.attempts, *result.attempts],
        verification_evidence=evidence,
    )
    run_context.record_source_asset_id(committed.asset_id)
    run_context.record_recipe(verified.recipe_id)
    return _success(
        request.operation,
        recipe=_recipe_metadata(verified),
        source_asset=committed.model_dump(mode="json"),
    )


def _find(
    runtime: CreateSkillRuntime,
    request: FindRecipeRequest,
) -> dict[str, object]:
    recipes = runtime.store.find_verified(
        request.domain,
        request.capability,
        request.host,
    )
    return _success(
        request.operation,
        recipes=[_recipe_metadata(recipe) for recipe in recipes],
    )


def _request_promotion(
    runtime: CreateSkillRuntime,
    request: RequestPromotionRequest,
) -> dict[str, object]:
    recipe = runtime.store.request_promotion(request.recipe_id)
    return _success(request.operation, recipe=_recipe_metadata(recipe))


def _recipe_metadata(recipe: WorkflowRecipe) -> dict[str, object]:
    return {
        "recipe_id": recipe.recipe_id,
        "version": recipe.version,
        "digest": recipe.digest,
        "status": recipe.status.value,
        "domain": recipe.domain,
        "capability": recipe.capability,
        "allowed_hosts": list(recipe.allowed_hosts),
        "verified_at": recipe.verified_at.isoformat() if recipe.verified_at else None,
        "promotion_requested_at": (
            recipe.promotion_requested_at.isoformat() if recipe.promotion_requested_at else None
        ),
        "last_succeeded_at": (
            recipe.last_succeeded_at.isoformat() if recipe.last_succeeded_at else None
        ),
    }


def _success(operation: str, **values: object) -> dict[str, object]:
    return {"status": "ok", "operation": operation, **values}


def _error(code: str, message: str) -> str:
    return json.dumps(
        {"status": "error", "error": {"code": code, "message": message}},
        ensure_ascii=False,
    )


create_skill_tool = FunctionTool(
    name="create_skill",
    description=(
        "Develop, validate, find, or request promotion of a declarative "
        "WorkflowRecipe. This internal tool never accepts executable code."
    ),
    params_json_schema=_REQUEST_ADAPTER.json_schema(),
    on_invoke_tool=_invoke_create_skill,
    strict_json_schema=False,
)

create_skill_skill = SkillDef(
    name="create_skill",
    category=SkillCategory.PROCESSING,
    description="Develop and validate non-executable data acquisition WorkflowRecipes.",
    instructions=(
        "Use create_skill only for an evidenced capability gap. "
        "It accepts declarative WorkflowRecipes and never executable code."
    ),
    tools=[create_skill_tool],
    supported_sources=[],
    version="0.1.0",
    user_selectable=False,
)

skill_registry.register(create_skill_skill)
