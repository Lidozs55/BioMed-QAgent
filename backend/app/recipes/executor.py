"""Controlled replay of persisted, verified WorkflowRecipes."""

from __future__ import annotations

import asyncio
import math
import re
from collections.abc import Mapping
from contextlib import AbstractAsyncContextManager, AsyncExitStack
from dataclasses import dataclass, field
from datetime import UTC, datetime
from string import Formatter
from types import TracebackType
from typing import Protocol, Self
from urllib.parse import quote, urljoin

from app.domain.contracts import (
    ApiRequestStep,
    BrowserActionStep,
    DataLevel,
    DownloadAttempt,
    DownloadStatus,
    HtmlExtractStep,
    RecipeAttempt,
    RecipeStatus,
    SourceAsset,
    WorkflowRecipe,
    generate_prefixed_uuid,
)
from app.integrations.acquisition import (
    AcquisitionFailure,
    ValidatedRecipeTarget,
    validate_recipe_source_url,
)
from app.recipes.store import WorkflowRecipeStore, compute_recipe_digest
from app.subagents.staging import SubagentStagingWorkspace

_METHOD_ORDER = {"api": 0, "html": 1, "browser": 2}
_HEADER_NEWLINE = re.compile(r"[\r\n]")
_ROOT_SCHEMA_KEYS = {"type", "properties", "required", "additionalProperties"}
_PROPERTY_SCHEMA_KEYS = {
    "type",
    "enum",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
}
_PROPERTY_TYPES = {"string", "number", "integer", "boolean"}
_MAX_REDIRECTS = 5


@dataclass(frozen=True, slots=True)
class RecipeStepResponse:
    """One no-follow response from the injected client facade."""

    content: bytes
    status_code: int
    media_type: str
    redirect_url: str | None = None
    error: str | None = None

    @property
    def transport_ok(self) -> bool:
        return 200 <= self.status_code < 300 and self.error is None


@dataclass(slots=True)
class RecipeBrowserAuthorizationScope:
    """Executor-owned browser authorization state for one Recipe execution."""

    allowed_hosts: tuple[str, ...]
    document_target: ValidatedRecipeTarget | None = None
    authorizations: list[tuple[str, ValidatedRecipeTarget]] = field(default_factory=list)
    _active: bool = False

    async def __aenter__(self) -> Self:
        if self._active:
            raise RuntimeError("browser authorization scope is already active")
        self._active = True
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._active = False

    def validate_request(
        self,
        url: str,
        *,
        resource_type: str,
    ) -> ValidatedRecipeTarget:
        if not self._active:
            raise RuntimeError("browser request authorization used outside its scope")
        if not resource_type.strip():
            raise ValueError("browser resource_type is required")
        target = validate_recipe_source_url(url, list(self.allowed_hosts))
        self.authorizations.append((resource_type, target))
        if resource_type == "main_frame":
            self.document_target = target
        return target


class BrowserRequestAuthorizer(Protocol):
    """Authorize one adapter-declared browser request before transport."""

    def __call__(
        self,
        url: str,
        *,
        resource_type: str,
    ) -> ValidatedRecipeTarget: ...


class RecipeClient(Protocol):
    """Trusted I/O boundary for pinned HTTP and intercepted browser transport.

    A browser adapter must install ``authorize_request`` as its route
    interception callback before yielding from ``browser_authorization`` and
    must keep it installed for the full action. Every main-frame, redirect, and
    subresource request must call the callback before transport. The Task 6
    Playwright adapter owns that installation; the executor does not trust a
    response-side boolean assertion.
    """

    async def api_request(
        self,
        *,
        method: str,
        target: ValidatedRecipeTarget,
        headers: Mapping[str, str],
        query_params: Mapping[str, str],
        timeout_seconds: float,
    ) -> RecipeStepResponse: ...

    async def html_extract(
        self,
        *,
        target: ValidatedRecipeTarget,
        selectors: Mapping[str, str],
        timeout_seconds: float,
    ) -> RecipeStepResponse: ...

    def browser_authorization(
        self,
        *,
        authorize_request: BrowserRequestAuthorizer,
    ) -> AbstractAsyncContextManager[None]: ...

    async def browser_action(
        self,
        *,
        action: str,
        target: str | None,
        value: str | None,
        current_url: str,
        timeout_seconds: float,
    ) -> RecipeStepResponse: ...


@dataclass(frozen=True, slots=True)
class RecipeExecutionResult:
    source_asset: SourceAsset
    download_attempt: DownloadAttempt
    attempts: tuple[RecipeAttempt, ...] = field(default_factory=tuple)


class RecipeExecutor:
    """Execute exact Recipe versions loaded from one trusted store."""

    def __init__(
        self,
        *,
        client: RecipeClient,
        store: WorkflowRecipeStore,
    ) -> None:
        self._client = client
        self._store = store

    async def execute(
        self,
        *,
        recipe_id: str,
        version: int,
        inputs: Mapping[str, object],
        workspace: SubagentStagingWorkspace,
    ) -> RecipeExecutionResult:
        recipe = self._load(recipe_id, version, required_status=RecipeStatus.VERIFIED)
        return await self._execute(recipe, inputs, workspace)

    async def execute_for_validation(
        self,
        *,
        recipe_id: str,
        version: int,
        inputs: Mapping[str, object],
        workspace: SubagentStagingWorkspace,
    ) -> RecipeExecutionResult:
        """Execute one trusted DRAFT for validation without enabling replay."""

        recipe = self._load(recipe_id, version, required_status=RecipeStatus.DRAFT)
        return await self._execute(recipe, inputs, workspace)

    async def _execute(
        self,
        recipe: WorkflowRecipe,
        inputs: Mapping[str, object],
        workspace: SubagentStagingWorkspace,
    ) -> RecipeExecutionResult:
        declared_inputs = self._validate_inputs(recipe, inputs)
        self._validate_step_order(recipe)
        try:
            async with asyncio.timeout(recipe.timeout_seconds):
                return await self._execute_steps(
                    recipe,
                    declared_inputs,
                    workspace,
                )
        except TimeoutError as error:
            raise TimeoutError("recipe execution timed out") from error

    async def _execute_steps(
        self,
        recipe: WorkflowRecipe,
        inputs: Mapping[str, object],
        workspace: SubagentStagingWorkspace,
    ) -> RecipeExecutionResult:
        async with AsyncExitStack() as browser_stack:
            return await self._execute_steps_in_scope(
                recipe,
                inputs,
                workspace,
                browser_stack,
            )

    async def _execute_steps_in_scope(
        self,
        recipe: WorkflowRecipe,
        inputs: Mapping[str, object],
        workspace: SubagentStagingWorkspace,
        browser_stack: AsyncExitStack,
    ) -> RecipeExecutionResult:
        attempts: list[RecipeAttempt] = []
        current_target: ValidatedRecipeTarget | None = None
        last_timed_out = False
        browser_started = False
        browser_authorization: RecipeBrowserAuthorizationScope | None = None
        for index, step in enumerate(recipe.steps):
            method = self._method_for_step(step)
            started_at = datetime.now(UTC)
            request_url = current_target.url if current_target else ""
            response: RecipeStepResponse | None = None
            reason: str | None = None
            terminal = False
            try:
                if isinstance(step, (ApiRequestStep, HtmlExtractStep)):
                    initial_target = self._render_target(
                        step.url_template,
                        inputs,
                        recipe,
                    )
                    request_url = initial_target.url
                    response, current_target = await self._execute_http_step(
                        step,
                        initial_target,
                        inputs,
                        recipe,
                    )
                    terminal = True
                elif isinstance(step, BrowserActionStep):
                    if not browser_started:
                        self._require_browser_evidence(recipe, attempts)
                        browser_started = True
                        browser_authorization = RecipeBrowserAuthorizationScope(
                            tuple(recipe.allowed_hosts)
                        )
                        await browser_stack.enter_async_context(browser_authorization)
                        await browser_stack.enter_async_context(
                            self._client.browser_authorization(
                                authorize_request=(browser_authorization.validate_request)
                            )
                        )
                    assert browser_authorization is not None
                    if step.action == "navigate":
                        url_template = step.value or step.target
                        if not url_template:
                            raise ValueError("browser navigate requires a URL")
                        navigation_url = self._render_template(
                            url_template,
                            inputs,
                            encoded=True,
                        )
                        request_url = navigation_url
                        target = request_url if step.target is not None else None
                        value = request_url if step.value is not None else None
                        action_current_url = navigation_url
                    else:
                        target = self._render_optional(step.target, inputs)
                        value = self._render_optional(step.value, inputs)
                        if browser_authorization.document_target is None:
                            raise ValueError(
                                "browser actions require an authorized main-frame document"
                            )
                        action_current_url = browser_authorization.document_target.url
                    response = await asyncio.wait_for(
                        self._client.browser_action(
                            action=step.action,
                            target=target,
                            value=value,
                            current_url=action_current_url,
                            timeout_seconds=step.timeout_seconds,
                        ),
                        timeout=step.timeout_seconds,
                    )
                    if browser_authorization.document_target is None:
                        raise ValueError(
                            "browser navigation did not authorize a main-frame document"
                        )
                    current_target = browser_authorization.document_target
                    terminal = step.action == "extract"
                else:  # pragma: no cover - discriminated validation is exhaustive
                    raise ValueError("unsupported Recipe step type")
            except TimeoutError:
                last_timed_out = True
                reason = "step timed out"
            except AcquisitionFailure:
                raise
            except (OSError, RuntimeError) as error:
                reason = f"{type(error).__name__}: {error}"

            finished_at = datetime.now(UTC)
            if response is not None and not response.transport_ok:
                reason = response.error or (f"request returned HTTP {response.status_code}")
            if response is not None and response.transport_ok:
                if terminal and not response.content:
                    reason = "explicit output step returned no source bytes"
                else:
                    action_reason = (
                        f"browser action {step.action} succeeded"
                        if isinstance(step, BrowserActionStep)
                        else f"{method} step succeeded"
                    )
                    attempts.append(
                        RecipeAttempt(
                            method=method,
                            url=current_target.url if current_target is not None else request_url,
                            status="succeeded",
                            status_code=response.status_code,
                            reason=action_reason,
                            started_at=started_at,
                            finished_at=finished_at,
                        )
                    )
                    if terminal:
                        assert current_target is not None
                        return self._build_result(
                            recipe=recipe,
                            inputs=inputs,
                            step=step,
                            response=response,
                            result_url=current_target.url,
                            attempts=attempts,
                            started_at=started_at,
                            finished_at=finished_at,
                            workspace=workspace,
                        )
                    continue

            fallback = self._next_method(recipe, index)
            attempts.append(
                RecipeAttempt(
                    method=method,
                    url=current_target.url if current_target is not None else request_url,
                    status="failed",
                    status_code=response.status_code
                    if response is not None and response.status_code >= 100
                    else None,
                    reason=reason or "step did not produce source bytes",
                    fallback_reason=(
                        f"falling back to {fallback}"
                        if fallback is not None and fallback != method
                        else None
                    ),
                    started_at=started_at,
                    finished_at=finished_at,
                )
            )
            if isinstance(step, BrowserActionStep):
                break
        if last_timed_out:
            raise TimeoutError("recipe execution timed out")
        summary = "; ".join(f"{attempt.method}: {attempt.reason}" for attempt in attempts)
        raise RuntimeError(f"all Recipe steps failed: {summary}")

    async def _execute_http_step(
        self,
        step: ApiRequestStep | HtmlExtractStep,
        initial_target: ValidatedRecipeTarget,
        inputs: Mapping[str, object],
        recipe: WorkflowRecipe,
    ) -> tuple[RecipeStepResponse, ValidatedRecipeTarget]:
        current = initial_target
        async with asyncio.timeout(step.timeout_seconds):
            for redirect_count in range(_MAX_REDIRECTS + 1):
                if isinstance(step, ApiRequestStep):
                    response = await self._client.api_request(
                        method=step.method,
                        target=current,
                        headers=self._render_mapping(
                            step.request_headers,
                            inputs,
                            encoded=False,
                            headers=True,
                        ),
                        query_params=self._render_mapping(
                            step.query_params,
                            inputs,
                            encoded=False,
                        ),
                        timeout_seconds=step.timeout_seconds,
                    )
                else:
                    response = await self._client.html_extract(
                        target=current,
                        selectors=step.selectors,
                        timeout_seconds=step.timeout_seconds,
                    )
                if response.redirect_url is None:
                    return response, current
                if redirect_count >= _MAX_REDIRECTS:
                    raise RuntimeError("Recipe request exceeded redirect limit")
                redirected_url = urljoin(current.url, response.redirect_url)
                current = validate_recipe_source_url(
                    redirected_url,
                    recipe.allowed_hosts,
                )
        raise AssertionError("redirect loop must return or raise")

    def _build_result(
        self,
        *,
        recipe: WorkflowRecipe,
        inputs: Mapping[str, object],
        step: ApiRequestStep | HtmlExtractStep | BrowserActionStep,
        response: RecipeStepResponse,
        result_url: str,
        attempts: list[RecipeAttempt],
        started_at: datetime,
        finished_at: datetime,
        workspace: SubagentStagingWorkspace,
    ) -> RecipeExecutionResult:
        mapping = recipe.source_asset_mapping
        source_id = self._render_optional(
            str(mapping.get("source_id") or f"src_recipe_{recipe.recipe_id}"),
            inputs,
        )
        filename = self._render_optional(
            str(mapping.get("filename") or step.output_name or "recipe-result.bin"),
            inputs,
        )
        if source_id is None or filename is None:
            raise ValueError("Recipe SourceAsset mapping is incomplete")
        try:
            data_level = DataLevel(str(mapping.get("data_level", "metadata")))
        except ValueError as error:
            raise ValueError("Recipe SourceAsset data_level is invalid") from error
        media_type = str(mapping.get("media_type") or response.media_type).split(";", 1)[0]
        attempt_id = generate_prefixed_uuid("download_attempt")
        asset = workspace.stage_bytes(
            content=response.content,
            filename=filename,
            source_id=source_id,
            successful_attempt_id=attempt_id,
            data_level=data_level,
            media_type=media_type,
        )
        download_attempt = DownloadAttempt(
            attempt_id=attempt_id,
            source_id=source_id,
            url=result_url,
            status=DownloadStatus.SUCCEEDED,
            bytes_received=len(response.content),
            started_at=started_at,
            finished_at=finished_at,
        )
        return RecipeExecutionResult(
            source_asset=asset,
            download_attempt=download_attempt,
            attempts=tuple(attempts),
        )

    def _load(
        self,
        recipe_id: str,
        version: int,
        *,
        required_status: RecipeStatus,
    ) -> WorkflowRecipe:
        recipe = self._store.get(recipe_id, version)
        validated = WorkflowRecipe.model_validate(recipe.model_dump(mode="json"))
        if validated.recipe_id != recipe_id or validated.version != version:
            raise ValueError("stored Recipe identity does not match requested version")
        if validated.status is not required_status:
            if required_status is RecipeStatus.VERIFIED:
                raise ValueError("only verified Recipes may be executed")
            raise ValueError("only draft Recipes may be executed for validation")
        if not validated.digest or validated.digest != compute_recipe_digest(validated):
            raise ValueError("Recipe digest does not match its stored content")
        return validated

    @classmethod
    def _validate_inputs(
        cls,
        recipe: WorkflowRecipe,
        inputs: Mapping[str, object],
    ) -> dict[str, object]:
        schema = recipe.input_schema
        if not isinstance(schema, dict):
            raise ValueError("Recipe input_schema must be an object")
        unsupported = set(schema) - _ROOT_SCHEMA_KEYS
        if unsupported:
            raise ValueError(f"unsupported Recipe input_schema fields: {sorted(unsupported)}")
        if schema.get("type") != "object":
            raise ValueError("Recipe input_schema must describe an object")
        if schema.get("additionalProperties") is not False:
            raise ValueError("Recipe additionalProperties must be false")
        properties = schema.get("properties")
        required = schema.get("required")
        if not isinstance(properties, dict) or not isinstance(required, list):
            raise ValueError("Recipe input_schema properties and required are invalid")
        if (
            any(not isinstance(name, str) or not name for name in properties)
            or any(not isinstance(name, str) for name in required)
            or len(set(required)) != len(required)
            or not set(required).issubset(properties)
        ):
            raise ValueError("Recipe input_schema property declarations are invalid")
        for name, property_schema in properties.items():
            cls._validate_property_schema(name, property_schema)
        supplied = set(inputs)
        missing = set(required) - supplied
        unexpected = supplied - set(properties)
        if missing:
            raise ValueError(f"missing Recipe inputs: {', '.join(sorted(missing))}")
        if unexpected:
            raise ValueError(f"unexpected Recipe inputs: {', '.join(sorted(unexpected))}")
        for name, value in inputs.items():
            cls._validate_input_value(name, value, properties[name])
        return dict(inputs)

    @staticmethod
    def _validate_property_schema(name: str, schema: object) -> None:
        if not isinstance(schema, dict):
            raise ValueError(f"unsupported schema for Recipe input {name}")
        unsupported = set(schema) - _PROPERTY_SCHEMA_KEYS
        if unsupported:
            raise ValueError(
                f"unsupported schema fields for Recipe input {name}: {sorted(unsupported)}"
            )
        value_type = schema.get("type")
        if value_type not in _PROPERTY_TYPES:
            raise ValueError(f"unsupported type for Recipe input {name}")
        if "pattern" in schema:
            if value_type != "string" or not isinstance(schema["pattern"], str):
                raise ValueError(f"unsupported pattern for Recipe input {name}")
            try:
                re.compile(schema["pattern"])
            except re.error as error:
                raise ValueError(f"invalid pattern for Recipe input {name}") from error
        for key in ("minLength", "maxLength"):
            if key in schema and (
                value_type != "string"
                or not isinstance(schema[key], int)
                or isinstance(schema[key], bool)
                or schema[key] < 0
            ):
                raise ValueError(f"unsupported {key} for Recipe input {name}")
        for key in ("minimum", "maximum"):
            if key in schema and (
                value_type not in {"number", "integer"} or not _is_number(schema[key])
            ):
                raise ValueError(f"unsupported {key} for Recipe input {name}")
        if (
            "minLength" in schema
            and "maxLength" in schema
            and schema["minLength"] > schema["maxLength"]
        ):
            raise ValueError(f"invalid length range for Recipe input {name}")
        if "minimum" in schema and "maximum" in schema and schema["minimum"] > schema["maximum"]:
            raise ValueError(f"invalid numeric range for Recipe input {name}")
        if "enum" in schema:
            enum = schema["enum"]
            if (
                not isinstance(enum, list)
                or not enum
                or any(not _matches_declared_type(candidate, value_type) for candidate in enum)
            ):
                raise ValueError(f"unsupported enum for Recipe input {name}")

    @staticmethod
    def _validate_input_value(
        name: str,
        value: object,
        schema: Mapping[str, object],
    ) -> None:
        value_type = schema["type"]
        valid_type = {
            "string": isinstance(value, str),
            "number": _is_number(value),
            "integer": isinstance(value, int) and not isinstance(value, bool),
            "boolean": isinstance(value, bool),
        }[value_type]
        if not valid_type:
            raise ValueError(f"Recipe input {name} has invalid type")
        enum = schema.get("enum")
        if isinstance(enum, list) and not any(
            type(value) is type(candidate) and value == candidate for candidate in enum
        ):
            raise ValueError(f"Recipe input {name} is outside its enum")
        if isinstance(value, str):
            if "minLength" in schema and len(value) < schema["minLength"]:
                raise ValueError(f"Recipe input {name} is shorter than minLength")
            if "maxLength" in schema and len(value) > schema["maxLength"]:
                raise ValueError(f"Recipe input {name} is longer than maxLength")
            pattern = schema.get("pattern")
            if isinstance(pattern, str) and re.search(pattern, value) is None:
                raise ValueError(f"Recipe input {name} does not match pattern")
        if _is_number(value):
            if "minimum" in schema and value < schema["minimum"]:
                raise ValueError(f"Recipe input {name} is below minimum")
            if "maximum" in schema and value > schema["maximum"]:
                raise ValueError(f"Recipe input {name} is above maximum")

    @staticmethod
    def _require_browser_evidence(
        recipe: WorkflowRecipe,
        current_attempts: list[RecipeAttempt],
    ) -> None:
        evidence = [*recipe.attempts, *current_attempts]
        for method in ("api", "html"):
            method_attempts = [attempt for attempt in evidence if attempt.method == method]
            if not method_attempts or method_attempts[-1].status not in {"failed", "skipped"}:
                raise ValueError(
                    "browser execution requires audited API and HTML failed/skipped evidence"
                )

    @staticmethod
    def _validate_step_order(recipe: WorkflowRecipe) -> None:
        order = [_METHOD_ORDER[RecipeExecutor._method_for_step(step)] for step in recipe.steps]
        if order != sorted(order):
            raise ValueError("Recipe steps must follow api, html, browser order")

    @staticmethod
    def _method_for_step(
        step: ApiRequestStep | HtmlExtractStep | BrowserActionStep,
    ) -> str:
        if isinstance(step, ApiRequestStep):
            return "api"
        if isinstance(step, HtmlExtractStep):
            return "html"
        return "browser"

    @staticmethod
    def _next_method(recipe: WorkflowRecipe, index: int) -> str | None:
        if index + 1 >= len(recipe.steps):
            return None
        return RecipeExecutor._method_for_step(recipe.steps[index + 1])

    @staticmethod
    def _render_target(
        template: str,
        inputs: Mapping[str, object],
        recipe: WorkflowRecipe,
    ) -> ValidatedRecipeTarget:
        rendered = RecipeExecutor._render_template(
            template,
            inputs,
            encoded=True,
        )
        return validate_recipe_source_url(rendered, recipe.allowed_hosts)

    @staticmethod
    def _render_mapping(
        values: Mapping[str, str],
        inputs: Mapping[str, object],
        *,
        encoded: bool,
        headers: bool = False,
    ) -> dict[str, str]:
        rendered = {
            key: RecipeExecutor._render_template(value, inputs, encoded=encoded)
            for key, value in values.items()
        }
        if headers and any(
            _HEADER_NEWLINE.search(key) or _HEADER_NEWLINE.search(value)
            for key, value in rendered.items()
        ):
            raise ValueError("Recipe headers must not contain newlines")
        return rendered

    @staticmethod
    def _render_optional(
        value: str | None,
        inputs: Mapping[str, object],
    ) -> str | None:
        if value is None:
            return None
        return RecipeExecutor._render_template(value, inputs, encoded=False)

    @staticmethod
    def _render_template(
        template: str,
        inputs: Mapping[str, object],
        *,
        encoded: bool,
    ) -> str:
        pieces: list[str] = []
        for literal, field_name, format_spec, conversion in Formatter().parse(template):
            pieces.append(literal)
            if field_name is None:
                continue
            if (
                not field_name
                or field_name not in inputs
                or format_spec
                or conversion
                or any(character in field_name for character in ".[]")
            ):
                raise ValueError(f"undeclared or unsafe template slot: {field_name}")
            raw = str(inputs[field_name])
            pieces.append(quote(raw, safe="") if encoded else raw)
        return "".join(pieces)


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _matches_declared_type(value: object, value_type: object) -> bool:
    return {
        "string": isinstance(value, str),
        "number": _is_number(value),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
    }.get(value_type, False)
