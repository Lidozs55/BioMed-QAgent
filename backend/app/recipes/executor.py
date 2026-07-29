"""Controlled replay of verified, declarative WorkflowRecipes."""

from __future__ import annotations

import asyncio
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from string import Formatter
from typing import Protocol
from urllib.parse import quote

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
from app.integrations.acquisition import validate_recipe_source_url
from app.recipes.store import compute_recipe_digest
from app.subagents.staging import SubagentStagingWorkspace

_METHOD_ORDER = {"api": 0, "html": 1, "browser": 2}
_HEADER_NEWLINE = re.compile(r"[\r\n]")


@dataclass(frozen=True, slots=True)
class RecipeStepResponse:
    """Normalized result returned by the injected crawler/client facade."""

    content: bytes
    final_url: str
    status_code: int
    media_type: str
    redirect_chain: tuple[str, ...] = ()
    error: str | None = None

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300 and bool(self.content) and self.error is None


class RecipeClient(Protocol):
    async def api_request(
        self,
        *,
        method: str,
        url: str,
        headers: Mapping[str, str],
        query_params: Mapping[str, str],
        timeout_seconds: float,
    ) -> RecipeStepResponse: ...

    async def html_extract(
        self,
        *,
        url: str,
        selectors: Mapping[str, str],
        timeout_seconds: float,
    ) -> RecipeStepResponse: ...

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
    """Execute only integrity-checked VERIFIED Recipes through injected I/O."""

    def __init__(self, *, client: RecipeClient) -> None:
        self._client = client

    async def execute(
        self,
        recipe: WorkflowRecipe,
        inputs: Mapping[str, object],
        workspace: SubagentStagingWorkspace,
    ) -> RecipeExecutionResult:
        validated = self._revalidate_recipe(recipe)
        declared_inputs = self._validate_inputs(validated, inputs)
        self._validate_step_order(validated)
        try:
            async with asyncio.timeout(validated.timeout_seconds):
                return await self._execute_steps(
                    validated,
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
        attempts: list[RecipeAttempt] = []
        current_url = ""
        last_timed_out = False
        for index, step in enumerate(recipe.steps):
            method = self._method_for_step(step)
            started_at = datetime.now(UTC)
            request_url = current_url
            response: RecipeStepResponse | None = None
            reason: str | None = None
            try:
                if isinstance(step, ApiRequestStep):
                    request_url = self._render_url(step.url_template, inputs, recipe)
                    response = await asyncio.wait_for(
                        self._client.api_request(
                            method=step.method,
                            url=request_url,
                            headers=self._render_mapping(
                                step.request_headers, inputs, encoded=False, headers=True
                            ),
                            query_params=self._render_mapping(
                                step.query_params, inputs, encoded=False
                            ),
                            timeout_seconds=step.timeout_seconds,
                        ),
                        timeout=step.timeout_seconds,
                    )
                elif isinstance(step, HtmlExtractStep):
                    request_url = self._render_url(step.url_template, inputs, recipe)
                    response = await asyncio.wait_for(
                        self._client.html_extract(
                            url=request_url,
                            selectors=step.selectors,
                            timeout_seconds=step.timeout_seconds,
                        ),
                        timeout=step.timeout_seconds,
                    )
                elif isinstance(step, BrowserActionStep):
                    if step.action == "navigate":
                        url_template = step.value or step.target
                        if not url_template:
                            raise ValueError("browser navigate requires a URL")
                        request_url = self._render_url(
                            url_template,
                            inputs,
                            recipe,
                        )
                        target = request_url if step.target is not None else None
                        value = request_url if step.value is not None else None
                        current_url = request_url
                    else:
                        target = self._render_optional(step.target, inputs)
                        value = self._render_optional(step.value, inputs)
                    if not current_url:
                        raise ValueError("browser actions require a prior validated navigation URL")
                    response = await asyncio.wait_for(
                        self._client.browser_action(
                            action=step.action,
                            target=target,
                            value=value,
                            current_url=current_url,
                            timeout_seconds=step.timeout_seconds,
                        ),
                        timeout=step.timeout_seconds,
                    )
                else:  # pragma: no cover - discriminated revalidation makes this impossible
                    raise ValueError("unsupported Recipe step type")
            except TimeoutError:
                last_timed_out = True
                reason = "step timed out"
            except (OSError, RuntimeError) as error:
                reason = f"{type(error).__name__}: {error}"

            finished_at = datetime.now(UTC)
            if response is not None:
                self._validate_response_urls(response, recipe)
                current_url = response.final_url
                if not response.ok:
                    reason = response.error or (f"request returned HTTP {response.status_code}")
            if response is not None and response.ok:
                attempts.append(
                    RecipeAttempt(
                        method=method,
                        url=response.final_url,
                        status="succeeded",
                        status_code=response.status_code,
                        started_at=started_at,
                        finished_at=finished_at,
                    )
                )
                return self._build_result(
                    recipe=recipe,
                    inputs=inputs,
                    step=step,
                    response=response,
                    attempts=attempts,
                    started_at=started_at,
                    finished_at=finished_at,
                    workspace=workspace,
                )

            fallback = self._next_method(recipe, index)
            attempts.append(
                RecipeAttempt(
                    method=method,
                    url=response.final_url if response is not None else request_url,
                    status="failed",
                    status_code=response.status_code
                    if response is not None and response.status_code >= 100
                    else None,
                    reason=reason or "step did not produce source bytes",
                    fallback_reason=(
                        f"falling back to {fallback}" if fallback is not None else None
                    ),
                    started_at=started_at,
                    finished_at=finished_at,
                )
            )
        if last_timed_out:
            raise TimeoutError("recipe execution timed out")
        summary = "; ".join(f"{attempt.method}: {attempt.reason}" for attempt in attempts)
        raise RuntimeError(f"all Recipe steps failed: {summary}")

    def _build_result(
        self,
        *,
        recipe: WorkflowRecipe,
        inputs: Mapping[str, object],
        step: ApiRequestStep | HtmlExtractStep | BrowserActionStep,
        response: RecipeStepResponse,
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
            url=response.final_url,
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

    @staticmethod
    def _revalidate_recipe(recipe: WorkflowRecipe) -> WorkflowRecipe:
        validated = WorkflowRecipe.model_validate(recipe.model_dump(mode="json"))
        if validated.status is not RecipeStatus.VERIFIED:
            raise ValueError("only verified Recipes may be executed")
        if not validated.digest or validated.digest != compute_recipe_digest(validated):
            raise ValueError("Recipe digest does not match its content")
        return validated

    @staticmethod
    def _validate_inputs(
        recipe: WorkflowRecipe,
        inputs: Mapping[str, object],
    ) -> dict[str, object]:
        schema = recipe.input_schema
        if schema.get("type", "object") != "object":
            raise ValueError("Recipe input_schema must describe an object")
        properties = schema.get("properties", {})
        required = schema.get("required", [])
        if not isinstance(properties, dict) or not isinstance(required, list):
            raise ValueError("Recipe input_schema properties and required are invalid")
        declared = set(properties)
        supplied = set(inputs)
        missing = set(required) - supplied
        unexpected = supplied - declared
        if missing:
            raise ValueError(f"missing Recipe inputs: {', '.join(sorted(missing))}")
        if unexpected:
            raise ValueError(f"unexpected Recipe inputs: {', '.join(sorted(unexpected))}")
        return dict(inputs)

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
    def _validate_response_urls(
        response: RecipeStepResponse,
        recipe: WorkflowRecipe,
    ) -> None:
        for url in (*response.redirect_chain, response.final_url):
            validate_recipe_source_url(url, recipe.allowed_hosts)

    @staticmethod
    def _render_url(
        template: str,
        inputs: Mapping[str, object],
        recipe: WorkflowRecipe,
    ) -> str:
        rendered = RecipeExecutor._render_template(template, inputs, encoded=True)
        validate_recipe_source_url(rendered, recipe.allowed_hosts)
        return rendered

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
