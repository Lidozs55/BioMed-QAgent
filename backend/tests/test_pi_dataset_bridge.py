"""Private Dataset Core migration bridge tests."""

# ruff: noqa: SIM117 -- nested lifespan/client scopes keep test cleanup explicit.

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from pathlib import Path

import httpx
import pytest
from agents.tool_context import ToolContext
from app.compat.pi_dataset_bridge import BRIDGE_SECRET_HEADER
from app.config import Settings
from app.main import create_app
from app.pipeline.dataset_build_tool import (
    execute_dataset_build as legacy_execute_dataset_build,
)
from app.pipeline.dataset_build_tool import (
    validate_dataset_build_spec as legacy_validate_dataset_build_spec,
)

FIXTURES = Path(__file__).parent / "fixtures"
REPO_ROOT = Path(__file__).parents[2]
GOLDEN_ROOT = REPO_ROOT / "tests" / "migration" / "golden"
BRIDGE_SECRET = "bridge-secret"


def _spec(*, build_id: str = "build_bridge", schema_ref: str = "gene_expression.long.v1") -> dict[str, object]:
    return {
        "schema_version": "1.0",
        "build_id": build_id,
        "objective": "Build the migration fixture",
        "dataset_family": "gene_expression",
        "row_granularity": "gene_sample_measurement",
        "entities": {},
        "cohort_filters": {},
        "required_fields": [],
        "schema_ref": schema_ref,
        "source_bindings": [{
            "schema_version": "1.0",
            "binding_id": "binding_gdc",
            "source": "gdc",
            "acquisition": {
                "schema_version": "1.0",
                "mode": "builtin",
                "provider_id": "gdc.v1",
                "recipe_id": None,
                "recipe_version": None,
            },
            "adapter_id": "gdc.expression.v1",
            "accession": None,
            "parameters": {},
        }],
        "normalization_profile_ref": "gene_expression.normalization.v1",
        "merge_strategy": "append_by_canonical_row",
        "validation_profile_ref": "gene_expression.release.v1",
        "output_format": "csv",
        "target_entity_level": None,
    }


def _request(
    op: str,
    args: dict[str, object],
    *,
    request_id: str = "request_bridge",
    task_id: str = "task_bridge",
) -> dict[str, object]:
    return {
        "version": 1,
        "request_id": request_id,
        "task_id": task_id,
        "run_id": "run_bridge",
        "pi_session_id": "pi_bridge",
        "tool_call_id": "tool_bridge",
        "op": op,
        "args": args,
    }


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        output_dir=str(tmp_path / "output"),
        pi_dataset_bridge_secret=BRIDGE_SECRET,
    )


def _client(application, *, host: str = "127.0.0.1") -> httpx.AsyncClient:  # type: ignore[no-untyped-def]
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application, client=(host, 5000)),
        base_url="http://localhost",
        headers={BRIDGE_SECRET_HEADER: BRIDGE_SECRET},
    )


@pytest.mark.asyncio
async def test_bridge_requires_loopback_and_configured_secret(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output"), pi_dataset_bridge_secret="bridge-secret"))
    async with application.router.lifespan_context(application):
        loopback = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application, client=("127.0.0.1", 5000)),
            base_url="http://127.0.0.1",
        )
        remote = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application, client=("198.51.100.9", 5000)),
            base_url="http://localhost",
        )
        payload = _request("validate_dataset_build_spec", {"spec": _spec()})
        assert (await loopback.post("/internal/migration/pi/dataset/operations", json=payload)).status_code == 403
        response = await remote.post(
            "/internal/migration/pi/dataset/operations",
            json=payload,
            headers={BRIDGE_SECRET_HEADER: "bridge-secret"},
        )
        assert response.status_code == 403
        await loopback.aclose()
        await remote.aclose()


@pytest.mark.asyncio
async def test_bridge_rejects_loopback_requests_when_secret_is_not_configured(
    tmp_path: Path,
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(
            app=application,
            client=("127.0.0.1", 5000),
        ),
        base_url="http://localhost",
    ) as client:
        response = await client.post(
            "/internal/migration/pi/dataset/operations",
            json=_request("validate_dataset_build_spec", {"spec": _spec()}),
        )

        assert response.status_code == 403


@pytest.mark.asyncio
async def test_bridge_binds_outer_run_and_logs_bounded_correlation(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.compat import pi_dataset_bridge
    from app.datasets.service import DatasetBuildExecutionError

    observed_run_ids: list[str | None] = []

    async def observe(run_ctx, spec, source_files, mapping_files):  # type: ignore[no-untyped-def]
        del spec, source_files, mapping_files
        observed_run_ids.append(run_ctx.managed_run_id)
        return DatasetBuildExecutionError(message="failed", retryable=False)

    monkeypatch.setattr(pi_dataset_bridge, "execute_dataset_build", observe)
    application = create_app(
        Settings(
            output_dir=str(tmp_path / "output"),
            pi_dataset_bridge_secret="bridge-secret",
        )
    )
    caplog.set_level(logging.INFO, logger="app.compat.pi_dataset_bridge")
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(
            app=application,
            client=("127.0.0.1", 5000),
        ),
        base_url="http://localhost",
        headers={BRIDGE_SECRET_HEADER: "bridge-secret"},
    ) as client:
        response = await client.post(
            "/internal/migration/pi/dataset/operations",
            json={
                **_request(
                    "execute_dataset_build",
                    {"spec": _spec(), "source_files": {}, "mapping_files": {}},
                    request_id="request_correlated",
                ),
                "pi_session_id": "pi_session_correlated",
                "tool_call_id": "tool_call_correlated",
            },
        )

    assert response.json()["error"]["code"] == "core_execution_error"
    assert observed_run_ids == ["run_bridge"]
    record = next(
        record for record in caplog.records if record.getMessage() == "legacy.bridge.response"
    )
    assert record.request_id == "request_correlated"
    assert record.task_id == "task_bridge"
    assert record.run_id == "run_bridge"
    assert record.pi_session_id == "pi_session_correlated"
    assert record.tool_call_id == "tool_call_correlated"
    assert record.outcome == "core_execution_error"
    assert record.duration_ms >= 0


@pytest.mark.asyncio
async def test_bridge_validates_strict_dto_and_spec_rejection(tmp_path: Path) -> None:
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application):
        async with _client(application, host="::1") as client:
            rejected = await client.post(
                "/internal/migration/pi/dataset/operations",
                json=_request("validate_dataset_build_spec", {"spec": _spec(schema_ref="unknown.schema.v1")}),
            )
            body = rejected.json()
            assert body["ok"] is False
            assert body["error"]["code"] == "spec_rejected"
            assert "unknown_schema" in body["error"]["details"]["reason_codes"]

            bad_family = _spec()
            bad_family["dataset_family"] = "clinical"
            family = await client.post(
                "/internal/migration/pi/dataset/operations",
                json=_request(
                    "validate_dataset_build_spec",
                    {"spec": bad_family},
                    request_id="request_family",
                ),
            )
            assert "family_mismatch" in family.json()["error"]["details"]["reason_codes"]

            bad_entity = _spec()
            bad_entity["target_entity_level"] = "probe"
            entity = await client.post(
                "/internal/migration/pi/dataset/operations",
                json=_request(
                    "validate_dataset_build_spec",
                    {"spec": bad_entity},
                    request_id="request_entity",
                ),
            )
            assert "entity_level_schema_mismatch" in entity.json()["error"]["details"]["reason_codes"]

            malformed = _request("validate_dataset_build_spec", {"spec": _spec()})
            malformed["extra"] = True
            invalid = await client.post("/internal/migration/pi/dataset/operations", json=malformed)
            invalid_body = invalid.json()
            assert invalid_body["data"] is None
            assert invalid_body["error"]["code"] == "invalid_input"

            invalid_json = await client.post(
                "/internal/migration/pi/dataset/operations",
                content="{",
                headers={"content-type": "application/json"},
            )
            assert invalid_json.json() == {
                "version": 1,
                "request_id": "invalid",
                "ok": False,
                "data": None,
                "error": {
                    "code": "invalid_input",
                    "message": "Bridge request failed structural validation",
                    "retryable": False,
                    "details": {"fields": [""]},
                },
            }


@pytest.mark.asyncio
async def test_bridge_executes_and_returns_logical_read_only_refs(tmp_path: Path) -> None:
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application):
        context = application.state.task_context_factory("task_bridge")
        shutil.copy(FIXTURES / "gdc" / "gdc_expression.tsv", context.work_dir.source_asset_file("gdc.tsv"))
        async with _client(application) as client:
            response = await client.post(
                "/internal/migration/pi/dataset/operations",
                json=_request("execute_dataset_build", {
                    "spec": _spec(),
                    "source_files": {"binding_gdc": "source_assets/gdc.tsv"},
                    "mapping_files": {},
                }),
            )
            body = response.json()
            assert body["ok"] is True
            assert body["data"]["build_result"]["status"] == "succeeded"
            serialized = json.dumps(body)
            assert str(tmp_path) not in serialized
            assert "output_dir" not in serialized
            assert "manifest_path" not in serialized

            lookup = await client.post(
                "/internal/migration/pi/dataset/operations",
                json=_request("get_build_result", {"build_id": "build_bridge"}, request_id="request_lookup"),
            )
            assert lookup.json()["data"] == body["data"]

            missing = await client.post(
                "/internal/migration/pi/dataset/operations",
                json=_request(
                    "get_build_result",
                    {"build_id": "build_missing"},
                    request_id="request_missing",
                ),
            )
            assert missing.json()["error"]["code"] == "invalid_input"


@pytest.mark.asyncio
@pytest.mark.parametrize("source_ref", ["../escape.tsv", "C:/secret.tsv", "/etc/passwd"])
async def test_bridge_rejects_non_task_relative_sources_without_publication(tmp_path: Path, source_ref: str) -> None:
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), _client(application) as client:
        response = await client.post(
            "/internal/migration/pi/dataset/operations",
            json=_request("execute_dataset_build", {
                "spec": _spec(),
                "source_files": {"binding_gdc": source_ref},
                "mapping_files": {},
            }),
        )
        assert response.json()["error"]["code"] == "invalid_input"
        assert not (tmp_path / "output" / "tasks" / "task_bridge" / "datasets_build").exists()


@pytest.mark.asyncio
async def test_bridge_rejects_source_symlink_escape_without_publication(tmp_path: Path) -> None:
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application):
        context = application.state.task_context_factory("task_bridge")
        outside = tmp_path / "outside.tsv"
        outside.write_text("gene_id\tS1\nENSG000001\t1\n", encoding="utf-8")
        linked = context.work_dir.source_asset_file("linked.tsv")
        try:
            linked.symlink_to(outside)
        except OSError as error:
            pytest.skip(f"symlink creation is unavailable: {error}")
        async with _client(application) as client:
            response = await client.post(
                "/internal/migration/pi/dataset/operations",
                json=_request(
                    "execute_dataset_build",
                    {
                        "spec": _spec(),
                        "source_files": {"binding_gdc": "source_assets/linked.tsv"},
                        "mapping_files": {},
                    },
                ),
            )
            assert response.json()["error"]["code"] == "invalid_input"
            assert not (context.work_dir.root / "datasets_build").exists()


@pytest.mark.asyncio
async def test_bridge_bounds_core_exception_without_leaking_details(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.compat import pi_dataset_bridge

    async def explode(*_args, **_kwargs):  # type: ignore[no-untyped-def]
        raise RuntimeError(f"secret-token at {tmp_path}")

    monkeypatch.setattr(pi_dataset_bridge, "execute_dataset_build", explode)
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application), _client(application) as client:
        response = await client.post(
            "/internal/migration/pi/dataset/operations",
            json=_request(
                "execute_dataset_build",
                {
                    "spec": _spec(),
                    "source_files": {},
                    "mapping_files": {},
                },
            ),
        )
        serialized = response.text
        assert response.json()["error"]["code"] == "core_execution_error"
        assert "secret-token" not in serialized
        assert str(tmp_path) not in serialized
        assert application.state.pi_dataset_bridge.active_count == 0


@pytest.mark.asyncio
async def test_cancel_side_channel_waits_for_core_observation_and_registry_cleanup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.compat import pi_dataset_bridge
    from app.datasets.service import DatasetBuildExecutionError

    observed = asyncio.Event()

    async def cooperative(run_ctx, spec, source_files, mapping_files):  # type: ignore[no-untyped-def]
        del spec, source_files, mapping_files
        await run_ctx.cancellation_requested.wait()
        observed.set()
        return DatasetBuildExecutionError(message="build ended with status cancelled", retryable=False)

    monkeypatch.setattr(pi_dataset_bridge, "execute_dataset_build", cooperative)
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application):
        async with _client(application) as client:
            original = asyncio.create_task(client.post(
                "/internal/migration/pi/dataset/operations",
                json=_request("execute_dataset_build", {
                    "spec": _spec(), "source_files": {"binding_gdc": "source_assets/gdc.tsv"}, "mapping_files": {},
                }, request_id="request_cancel"),
            ))
            await asyncio.sleep(0)
            cancel = await client.post("/internal/migration/pi/dataset/requests/request_cancel/cancel")
            assert cancel.status_code == 202
            response = await original
            assert observed.is_set()
            assert response.json()["error"]["code"] == "cancelled"
            assert application.state.pi_dataset_bridge.active_count == 0


@pytest.mark.asyncio
async def test_cancel_side_channel_interrupts_real_core_before_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.datasets.build.expression_runner import ExpressionBuildRunner

    reached_hold = asyncio.Event()
    release = asyncio.Event()
    real_validate = ExpressionBuildRunner._validate_profile

    async def held_validate(self, op, upstream):  # type: ignore[no-untyped-def]
        result = await real_validate(self, op, upstream)
        reached_hold.set()
        await release.wait()
        return result

    monkeypatch.setattr(ExpressionBuildRunner, "_validate_profile", held_validate)
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application):
        context = application.state.task_context_factory("task_real_cancel")
        shutil.copy(
            FIXTURES / "gdc" / "gdc_expression.tsv",
            context.work_dir.source_asset_file("gdc.tsv"),
        )
        async with _client(application) as client:
            original = asyncio.create_task(client.post(
                "/internal/migration/pi/dataset/operations",
                json=_request(
                    "execute_dataset_build",
                    {
                        "spec": _spec(build_id="build_real_cancel"),
                        "source_files": {"binding_gdc": "source_assets/gdc.tsv"},
                        "mapping_files": {},
                    },
                    request_id="request_real_cancel",
                    task_id="task_real_cancel",
                ),
            ))
            try:
                await asyncio.wait_for(reached_hold.wait(), timeout=5)
                cancel = await client.post(
                    "/internal/migration/pi/dataset/requests/request_real_cancel/cancel"
                )
                assert cancel.status_code == 202
                release.set()
                response = await asyncio.wait_for(original, timeout=10)
                assert response.json()["error"]["code"] == "cancelled"
                publish_dir = (
                    context.work_dir.root
                    / "datasets_build"
                    / "build_real_cancel"
                    / "publish"
                )
                assert list(publish_dir.glob("build_real_cancel_*")) == []
                assert not (publish_dir / "publication.json").exists()
                assert application.state.pi_dataset_bridge.active_count == 0
            finally:
                release.set()
                if not original.done():
                    original.cancel()
                    await asyncio.gather(original, return_exceptions=True)


@pytest.mark.asyncio
async def test_bridge_rejects_active_request_id_collision_and_cleans_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.compat import pi_dataset_bridge
    from app.datasets.service import DatasetBuildExecutionError

    entered = asyncio.Event()

    async def cooperative(run_ctx, spec, source_files, mapping_files):  # type: ignore[no-untyped-def]
        del spec, source_files, mapping_files
        entered.set()
        await run_ctx.cancellation_requested.wait()
        return DatasetBuildExecutionError(message="cancelled", retryable=False)

    monkeypatch.setattr(pi_dataset_bridge, "execute_dataset_build", cooperative)
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application):
        async with _client(application) as client:
            payload = _request("execute_dataset_build", {
                "spec": _spec(), "source_files": {"binding_gdc": "source_assets/gdc.tsv"}, "mapping_files": {},
            }, request_id="request_collision")
            first = asyncio.create_task(client.post("/internal/migration/pi/dataset/operations", json=payload))
            await entered.wait()
            duplicate = await client.post("/internal/migration/pi/dataset/operations", json=payload)
            assert duplicate.json()["error"]["code"] == "invalid_input"
            await client.post("/internal/migration/pi/dataset/requests/request_collision/cancel")
            await first
            assert application.state.pi_dataset_bridge.active_count == 0


def _stable_result(result: dict[str, object]) -> dict[str, object]:
    return {
        key: result[key]
        for key in (
            "status",
            "valid_row_count",
            "successful_sources",
            "rejected_sources",
            "reason_codes",
        )
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outcome",
    ["succeeded", "partial_success", "no_data", "spec_rejected"],
)
async def test_bridge_matches_legacy_function_tool_and_phase0d_goldens(
    tmp_path: Path,
    outcome: str,
) -> None:
    golden = json.loads((GOLDEN_ROOT / outcome / "fixture.json").read_text("utf-8"))
    spec = golden["spec"]
    application = create_app(_settings(tmp_path))
    async with application.router.lifespan_context(application):
        bridge_task = f"bridge_{outcome}"
        legacy_task = f"legacy_{outcome}"
        bridge_context = application.state.task_context_factory(bridge_task)
        legacy_context = application.state.task_context_factory(legacy_task)
        source_files: dict[str, str] = {}
        for source in golden["source_fixtures"]:
            source_path = REPO_ROOT / source["repo_relative_path"]
            filename = source_path.name
            shutil.copy(source_path, bridge_context.work_dir.source_asset_file(filename))
            shutil.copy(source_path, legacy_context.work_dir.source_asset_file(filename))
            source_files[source["binding_id"]] = f"source_assets/{filename}"

        tool_context = ToolContext(
            context=legacy_context,
            tool_name=(
                "validate_dataset_build_spec"
                if outcome == "spec_rejected"
                else "execute_dataset_build"
            ),
            tool_call_id=f"legacy_{outcome}",
            tool_arguments="{}",
        )
        async with _client(application) as client:
            if outcome == "spec_rejected":
                bridge_response = await client.post(
                    "/internal/migration/pi/dataset/operations",
                    json=_request(
                        "validate_dataset_build_spec",
                        {"spec": spec},
                        request_id="request_parity_spec",
                        task_id=bridge_task,
                    ),
                )
                legacy_raw = await legacy_validate_dataset_build_spec.on_invoke_tool(
                    tool_context,
                    json.dumps({"spec": json.dumps(spec)}),
                )
                legacy = json.loads(legacy_raw)
                bridge = bridge_response.json()
                assert bridge["error"]["code"] == "spec_rejected"
                assert bridge["error"]["details"]["reason_codes"] == legacy["reason_codes"]
                assert bridge["error"]["details"]["reason_codes"] == golden["build_result"]["reason_codes"]
                return

            bridge_response = await client.post(
                "/internal/migration/pi/dataset/operations",
                json=_request(
                    "execute_dataset_build",
                    {"spec": spec, "source_files": source_files, "mapping_files": {}},
                    request_id=f"request_parity_{outcome}",
                    task_id=bridge_task,
                ),
            )
            legacy_raw = await legacy_execute_dataset_build.on_invoke_tool(
                tool_context,
                json.dumps({
                    "spec": json.dumps(spec),
                    "source_files": json.dumps(source_files),
                    "mapping_files": "{}",
                }),
            )
            legacy = json.loads(legacy_raw)
            bridge = bridge_response.json()
            bridge_result = (
                bridge["data"]["build_result"]
                if bridge["ok"]
                else bridge["error"]["details"]["build_result"]
            )
            assert _stable_result(bridge_result) == _stable_result(legacy["result"])
            assert _stable_result(bridge_result) == _stable_result(golden["build_result"])
            assert bridge_result["build_id"] == spec["build_id"]
            if outcome in {"succeeded", "partial_success"}:
                bridge_artifacts = (
                    bridge["data"]["artifacts"]
                    if bridge["ok"]
                    else bridge["error"]["details"]["artifacts"]
                )
                legacy_manifest = json.loads(
                    Path(legacy["manifest_file"]).read_text("utf-8")
                )
                actual_digests = sorted(
                    (artifact["role"], artifact["sha256"])
                    for artifact in (
                        bridge_artifacts
                    )
                    if artifact["role"] != "provenance"
                )
                legacy_digests = sorted(
                    (artifact["role"], artifact["sha256"])
                    for artifact in legacy_manifest["artifacts"]
                    if artifact["role"] != "provenance"
                )
                assert actual_digests == legacy_digests
                assert {
                    artifact["sha256"]
                    for artifact in bridge_artifacts
                    if artifact["role"] == "schema"
                } == {
                    artifact["sha256"]
                    for artifact in golden["artifact_fixtures"]
                    if artifact["role"] == "schema"
                }
