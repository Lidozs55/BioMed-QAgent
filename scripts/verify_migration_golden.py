"""Capture or verify the deterministic Phase 0D DatasetBuild golden baseline.

The default mode is read-only. Pass ``--capture`` explicitly to replace the
committed fixture set with output derived from the current Python contracts,
deterministic DatasetBuild executor, and repository-local source fixtures.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = REPO_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.datasets.build.expression_runner import ExpressionBuildRunner  # noqa: E402
from app.datasets.contracts import (  # noqa: E402
    AcquisitionMode,
    BindingFailureDetail,
    BuildResult,
    BuildResultStatus,
    DatasetBuildSpec,
    DatasetManifest,
    DatasetPublication,
    SourceBinding,
    SourceBindingAcquisition,
    ValidationResult,
    ValidationResultStatus,
)
from app.datasets.runtime import DatasetBuildExecutor, build_operation_plan  # noqa: E402
from app.datasets.schema_registry import (  # noqa: E402
    SchemaRegistry,
    build_gene_expression_schema,
)
from app.datasets.spec_validator import SpecValidator  # noqa: E402
from app.domain.contracts import (  # noqa: E402
    DataLevel,
    EventEnvelope,
    RunCompletedPayload,
    SourceAsset,
    asset_id_from_sha256,
)

GOLDEN_ROOT = REPO_ROOT / "tests" / "migration" / "golden"
HEADER_ONLY_PATH = REPO_ROOT / "tests" / "migration" / "sources" / "header_only.tsv"
HEADER_ONLY_BYTES = b"gene_id\tS1\tS2\n"
FIXED_TIMESTAMP = datetime(2026, 8, 11, tzinfo=UTC)
OUTCOMES = ("succeeded", "partial_success", "no_data", "spec_rejected")
STATUS_BY_OUTCOME = {
    "succeeded": BuildResultStatus.SUCCEEDED,
    "partial_success": BuildResultStatus.PARTIAL_SUCCESS,
    "no_data": BuildResultStatus.NO_DATA,
    "spec_rejected": BuildResultStatus.SPEC_REJECTED,
}
CONTRACT_MODELS = (
    DatasetBuildSpec,
    BuildResult,
    ValidationResult,
    DatasetManifest,
    DatasetPublication,
    EventEnvelope,
)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")


def _repo_path(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def _binding(binding_id: str, source: str, adapter_id: str) -> SourceBinding:
    return SourceBinding(
        binding_id=binding_id,
        source=source,
        acquisition=SourceBindingAcquisition(
            mode=AcquisitionMode.BUILTIN,
            provider_id=f"{source}.v1",
        ),
        adapter_id=adapter_id,
    )


def _spec(
    outcome: str,
    bindings: list[SourceBinding],
    *,
    schema_ref: str = "gene_expression.long.v1",
) -> DatasetBuildSpec:
    return DatasetBuildSpec(
        build_id=f"golden_{outcome}",
        objective="Freeze the deterministic gene expression migration baseline",
        dataset_family="gene_expression",
        row_granularity="gene_sample_measurement",
        schema_ref=schema_ref,
        source_bindings=bindings,
        normalization_profile_ref="gene_expression.normalization.v1",
        merge_strategy="append_by_canonical_row",
        validation_profile_ref="gene_expression.release.v1",
    )


def _source_asset(binding_id: str, data: bytes, logical_name: str) -> SourceAsset:
    digest = _sha256(data)
    return SourceAsset(
        asset_id=asset_id_from_sha256(digest),
        kind="source",
        relative_path=f"source_assets/{logical_name}",
        sha256=digest,
        size_bytes=len(data),
        media_type="text/tab-separated-values",
        source_id=f"src_{binding_id}",
        successful_attempt_id=f"attempt_{binding_id}",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


def _source_reference(binding_id: str, path: Path, data: bytes) -> dict[str, Any]:
    return {
        "binding_id": binding_id,
        "repo_relative_path": _repo_path(path),
        "sha256": _sha256(data),
        "size_bytes": len(data),
    }


async def _execute_build(
    *,
    temp_root: Path,
    spec: DatasetBuildSpec,
    sources: dict[str, tuple[str, bytes]],
) -> tuple[Path, DatasetManifest, ValidationResult, DatasetPublication, dict[str, Any]]:
    source_paths: dict[str, Path] = {}
    source_assets: dict[str, SourceAsset] = {}
    for binding_id, (logical_name, data) in sources.items():
        path = temp_root / "sources" / binding_id / logical_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        source_paths[binding_id] = path
        source_assets[binding_id] = _source_asset(binding_id, data, logical_name)

    output_dir = temp_root / "build"
    per_binding_outcomes: dict[str, Any] = {}
    runner = ExpressionBuildRunner(
        spec=spec,
        registry=SchemaRegistry([build_gene_expression_schema()]),
        source_assets=source_assets,
        source_paths=source_paths,
        output_dir=output_dir,
        per_binding_outcomes=per_binding_outcomes,
    )
    plan = build_operation_plan(spec)
    executor = DatasetBuildExecutor(
        task_id=spec.build_id,
        build_id=spec.build_id,
        run_id=f"run_{spec.build_id}",
        state_dir=temp_root / "state" / spec.build_id,
        lock_path=temp_root / "build.lock",
        task_root=temp_root,
        plan=plan,
        run_operation=runner,
        per_binding_outcomes=per_binding_outcomes,
        source_assets=source_assets,
        implementation_versions={op.operation_id: "1.0.0" for op in plan},
    )
    outcome = await executor.run()
    if outcome.status != "completed":
        raise AssertionError(f"deterministic build failed: {outcome}")

    manifest = DatasetManifest.model_validate_json(
        (output_dir / "dataset_manifest.json").read_text("utf-8")
    )
    validation = ValidationResult(
        manifest_digest=manifest.sha256,
        profile_ref=str(manifest.validation_summary["profile_ref"]),
        status=ValidationResultStatus(str(manifest.validation_summary["status"])),
        checked_count=int(manifest.validation_summary["checked_count"]),
        failed_count=int(manifest.validation_summary["failed_count"]),
        report_path=str(manifest.validation_summary["report_path"]),
    )
    publication_path = next(
        (output_dir / "publish").glob(f"{spec.build_id}_*/publication.json")
    )
    publication = DatasetPublication.model_validate_json(
        publication_path.read_text("utf-8")
    ).model_copy(update={"published_at": FIXED_TIMESTAMP})
    return output_dir, manifest, validation, publication, per_binding_outcomes


def _event(build_result: BuildResult) -> EventEnvelope:
    return EventEnvelope(
        schema_version="2.0",
        event_id=f"event_{build_result.status.value}_golden",
        type="run_completed",
        task_id=f"task_{build_result.build_id}",
        run_id=f"run_{build_result.build_id}",
        sequence=1,
        timestamp=FIXED_TIMESTAMP,
        payload=RunCompletedPayload(build_result=build_result),
    )


def _artifact_documents(
    outcome: str,
    output_dir: Path,
    manifest: DatasetManifest,
) -> tuple[dict[str, bytes], list[dict[str, Any]]]:
    documents: dict[str, bytes] = {}
    references: list[dict[str, Any]] = []
    for artifact in manifest.artifacts:
        data = (output_dir / artifact.relative_path).read_bytes()
        repo_relative_path = (
            Path("tests")
            / "migration"
            / "golden"
            / outcome
            / "artifacts"
            / artifact.relative_path
        ).as_posix()
        documents[repo_relative_path] = data
        references.append(
            {
                "artifact_id": artifact.artifact_id,
                "role": artifact.role.value,
                "relative_path": artifact.relative_path,
                "repo_relative_path": repo_relative_path,
                "sha256": artifact.sha256,
                "size_bytes": artifact.size_bytes,
            }
        )
    return documents, references


def _published_fixture(
    *,
    outcome: str,
    spec: DatasetBuildSpec,
    source_references: list[dict[str, Any]],
    output_dir: Path,
    manifest: DatasetManifest,
    validation: ValidationResult,
    publication: DatasetPublication,
    per_binding_outcomes: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, bytes]]:
    rejected_sources = sorted(per_binding_outcomes)
    binding_ids = sorted(binding.binding_id for binding in spec.source_bindings)
    successful_sources = [item for item in binding_ids if item not in rejected_sources]
    status = STATUS_BY_OUTCOME[outcome]
    result = BuildResult(
        status=status,
        valid_row_count=manifest.row_count,
        successful_sources=successful_sources,
        rejected_sources=rejected_sources,
        publication_id=publication.publication_id,
        reason_codes=[],
        user_summary=(
            f"build {spec.build_id} published {manifest.row_count} valid row(s)"
            if status is BuildResultStatus.SUCCEEDED
            else (
                f"build {spec.build_id} partially published: "
                f"{len(successful_sources)} source(s) published, "
                f"{len(rejected_sources)} rejected"
            )
        ),
        build_id=spec.build_id,
    )
    artifact_documents, artifact_references = _artifact_documents(
        outcome, output_dir, manifest
    )
    fixture = {
        "fixture_version": 1,
        "outcome": outcome,
        "spec": spec.model_dump(mode="json"),
        "source_fixtures": source_references,
        "build_result": result.model_dump(mode="json"),
        "validation_result": validation.model_dump(mode="json"),
        "manifest": manifest.model_dump(mode="json"),
        "publication": publication.model_dump(mode="json"),
        "artifact_fixtures": artifact_references,
        "event_envelope": _event(result).model_dump(mode="json"),
    }
    return fixture, artifact_documents


def _terminal_fixture(
    *,
    outcome: str,
    spec: DatasetBuildSpec,
    source_references: list[dict[str, Any]],
    result: BuildResult,
) -> dict[str, Any]:
    return {
        "fixture_version": 1,
        "outcome": outcome,
        "spec": spec.model_dump(mode="json"),
        "source_fixtures": source_references,
        "build_result": result.model_dump(mode="json"),
        "validation_result": None,
        "manifest": None,
        "publication": None,
        "artifact_fixtures": [],
        "event_envelope": _event(result).model_dump(mode="json"),
    }


async def _capture_outcomes() -> dict[str, bytes]:
    documents: dict[str, bytes] = {}
    gdc_path = REPO_ROOT / "backend" / "tests" / "fixtures" / "gdc" / "gdc_expression.tsv"
    xena_path = (
        REPO_ROOT
        / "backend"
        / "tests"
        / "fixtures"
        / "ncbi"
        / "gse178352"
        / "xena_matrix.tsv"
    )
    gdc = gdc_path.read_bytes()
    xena = xena_path.read_bytes()
    documents[_repo_path(HEADER_ONLY_PATH)] = HEADER_ONLY_BYTES

    with tempfile.TemporaryDirectory(prefix="biomed-golden-") as temporary:
        temporary_root = Path(temporary)

        succeeded_spec = _spec(
            "succeeded",
            [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        )
        succeeded_output = await _execute_build(
            temp_root=temporary_root / "succeeded",
            spec=succeeded_spec,
            sources={"binding_gdc": (gdc_path.name, gdc)},
        )
        succeeded_fixture, succeeded_artifacts = _published_fixture(
            outcome="succeeded",
            spec=succeeded_spec,
            source_references=[_source_reference("binding_gdc", gdc_path, gdc)],
            output_dir=succeeded_output[0],
            manifest=succeeded_output[1],
            validation=succeeded_output[2],
            publication=succeeded_output[3],
            per_binding_outcomes=succeeded_output[4],
        )
        documents.update(succeeded_artifacts)
        documents["tests/migration/golden/succeeded/fixture.json"] = _json_bytes(
            succeeded_fixture
        )

        partial_spec = _spec(
            "partial_success",
            [
                _binding("binding_gdc", "gdc", "gdc.expression.v1"),
                _binding("binding_xena", "ucsc_xena", "xena.matrix.v1"),
            ],
        )
        partial_output = await _execute_build(
            temp_root=temporary_root / "partial_success",
            spec=partial_spec,
            sources={
                "binding_gdc": (HEADER_ONLY_PATH.name, HEADER_ONLY_BYTES),
                "binding_xena": (xena_path.name, xena),
            },
        )
        partial_fixture, partial_artifacts = _published_fixture(
            outcome="partial_success",
            spec=partial_spec,
            source_references=[
                _source_reference("binding_gdc", HEADER_ONLY_PATH, HEADER_ONLY_BYTES),
                _source_reference("binding_xena", xena_path, xena),
            ],
            output_dir=partial_output[0],
            manifest=partial_output[1],
            validation=partial_output[2],
            publication=partial_output[3],
            per_binding_outcomes=partial_output[4],
        )
        documents.update(partial_artifacts)
        documents["tests/migration/golden/partial_success/fixture.json"] = _json_bytes(
            partial_fixture
        )

    no_data_spec = _spec(
        "no_data",
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
    )
    no_data_result = BuildResult(
        status=BuildResultStatus.NO_DATA,
        valid_row_count=0,
        successful_sources=[],
        rejected_sources=["binding_gdc"],
        reason_codes=["no_primary_data"],
        user_summary="No publishable primary data was produced",
        recommended_next_action="Review the source selection or constraints",
        binding_failures=[
            BindingFailureDetail(
                binding_id="binding_gdc",
                reason_code="no_primary_data",
                message="source contained no primary rows",
            )
        ],
        build_id=no_data_spec.build_id,
    )
    no_data_fixture = _terminal_fixture(
        outcome="no_data",
        spec=no_data_spec,
        source_references=[
            _source_reference("binding_gdc", HEADER_ONLY_PATH, HEADER_ONLY_BYTES)
        ],
        result=no_data_result,
    )
    documents["tests/migration/golden/no_data/fixture.json"] = _json_bytes(
        no_data_fixture
    )

    rejected_spec = _spec(
        "spec_rejected",
        [_binding("binding_gdc", "gdc", "gdc.expression.v1")],
        schema_ref="gene_expression.unknown.v1",
    )
    validation = SpecValidator(
        registry=SchemaRegistry([build_gene_expression_schema()]),
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    ).validate(rejected_spec)
    if validation.valid or validation.reason_codes != ("unknown_schema",):
        raise AssertionError(f"unexpected spec rejection baseline: {validation}")
    rejected_result = BuildResult(
        status=BuildResultStatus.SPEC_REJECTED,
        valid_row_count=0,
        successful_sources=[],
        rejected_sources=["binding_gdc"],
        reason_codes=list(validation.reason_codes),
        user_summary="The submitted DatasetBuildSpec was rejected",
        recommended_next_action="Select a registered canonical schema",
        build_id=rejected_spec.build_id,
    )
    rejected_fixture = _terminal_fixture(
        outcome="spec_rejected",
        spec=rejected_spec,
        source_references=[_source_reference("binding_gdc", gdc_path, gdc)],
        result=rejected_result,
    )
    documents["tests/migration/golden/spec_rejected/fixture.json"] = _json_bytes(
        rejected_fixture
    )
    return documents


def _contract_snapshot() -> dict[str, Any]:
    return {
        "snapshot_version": 1,
        "contracts": {
            model.__name__: model.model_json_schema() for model in CONTRACT_MODELS
        },
    }


def capture_documents() -> dict[str, bytes]:
    """Render the complete committed fixture set without mutating the repo."""

    documents = asyncio.run(_capture_outcomes())
    documents["tests/migration/golden/contract-snapshot.json"] = _json_bytes(
        _contract_snapshot()
    )
    return dict(sorted(documents.items()))


def canonicalize(value: Any) -> Any:
    """Normalize only migration-approved volatile fields for comparisons."""

    if isinstance(value, list):
        return [canonicalize(item) for item in value]
    if not isinstance(value, dict):
        return value
    normalized: dict[str, Any] = {}
    for key, item in value.items():
        if key in {"timestamp", "published_at"}:
            normalized[key] = "<timestamp>"
        elif key == "event_id":
            normalized[key] = "<random-identifier>"
        elif key in {"user_summary", "recommended_next_action", "message"}:
            normalized[key] = "<natural-language>"
        else:
            normalized[key] = canonicalize(item)
    return normalized


def load_and_validate_fixture(outcome: str) -> dict[str, Any]:
    if outcome not in OUTCOMES:
        raise ValueError(f"unknown golden outcome: {outcome}")
    path = GOLDEN_ROOT / outcome / "fixture.json"
    fixture = json.loads(path.read_text("utf-8"))
    expected_keys = {
        "fixture_version",
        "outcome",
        "spec",
        "source_fixtures",
        "build_result",
        "validation_result",
        "manifest",
        "publication",
        "artifact_fixtures",
        "event_envelope",
    }
    if set(fixture) != expected_keys:
        raise AssertionError(f"{outcome}: unexpected fixture keys")

    spec = DatasetBuildSpec.model_validate(fixture["spec"])
    result = BuildResult.model_validate(fixture["build_result"])
    event = EventEnvelope.model_validate(fixture["event_envelope"])
    if fixture["outcome"] != outcome or result.status is not STATUS_BY_OUTCOME[outcome]:
        raise AssertionError(f"{outcome}: outcome/status mismatch")
    if event.payload.build_result != result:
        raise AssertionError(f"{outcome}: EventEnvelope BuildResult drift")
    if result.build_id != spec.build_id:
        raise AssertionError(f"{outcome}: BuildResult build_id drift")

    binding_ids = {binding.binding_id for binding in spec.source_bindings}
    covered = set(result.successful_sources) | set(result.rejected_sources)
    if covered != binding_ids:
        raise AssertionError(f"{outcome}: source coverage drift")

    if outcome in {"succeeded", "partial_success"}:
        validation = ValidationResult.model_validate(fixture["validation_result"])
        manifest = DatasetManifest.model_validate(fixture["manifest"])
        publication = DatasetPublication.model_validate(fixture["publication"])
        if validation.status is not ValidationResultStatus.PASSED:
            raise AssertionError(f"{outcome}: validation is not passed")
        if validation.manifest_digest != manifest.sha256:
            raise AssertionError(f"{outcome}: validation/manifest digest drift")
        if publication.manifest_ref != manifest.manifest_id:
            raise AssertionError(f"{outcome}: publication/manifest drift")
        if publication.publication_id != result.publication_id:
            raise AssertionError(f"{outcome}: BuildResult/publication drift")
        if manifest.row_count != result.valid_row_count:
            raise AssertionError(f"{outcome}: manifest row count drift")
        entries = {
            (entry.artifact_id, entry.role.value, entry.relative_path, entry.sha256)
            for entry in manifest.artifacts
        }
        references = {
            (item["artifact_id"], item["role"], item["relative_path"], item["sha256"])
            for item in fixture["artifact_fixtures"]
        }
        if entries != references:
            raise AssertionError(f"{outcome}: manifest artifact inventory drift")
    else:
        if any(
            fixture[key] is not None
            for key in ("validation_result", "manifest", "publication")
        ) or fixture["artifact_fixtures"] != []:
            raise AssertionError(f"{outcome}: absent outputs are not explicit")
    return fixture


def verify_referenced_hashes(fixture: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for reference in fixture["source_fixtures"] + fixture["artifact_fixtures"]:
        path = REPO_ROOT / reference["repo_relative_path"]
        if not path.is_file():
            errors.append(f"missing referenced file: {reference['repo_relative_path']}")
            continue
        data = path.read_bytes()
        if _sha256(data) != reference["sha256"]:
            errors.append(f"SHA-256 drift: {reference['repo_relative_path']}")
        if len(data) != reference["size_bytes"]:
            errors.append(f"size drift: {reference['repo_relative_path']}")
    return errors


def verify_committed_documents(expected: dict[str, bytes]) -> list[str]:
    errors: list[str] = []
    for relative_path, expected_bytes in expected.items():
        path = REPO_ROOT / relative_path
        if not path.is_file():
            errors.append(f"missing committed document: {relative_path}")
        elif path.read_bytes() != expected_bytes:
            errors.append(f"stable content drift: {relative_path}")
    return errors


def verify() -> list[str]:
    errors = verify_committed_documents(capture_documents())
    for outcome in OUTCOMES:
        try:
            fixture = load_and_validate_fixture(outcome)
        except (AssertionError, ValueError, KeyError, json.JSONDecodeError) as exc:
            errors.append(f"{outcome}: {exc}")
            continue
        errors.extend(verify_referenced_hashes(fixture))
    return errors


def capture() -> None:
    """Explicitly replace committed fixtures; never called by normal tests."""

    documents = capture_documents()
    for relative_path, data in documents.items():
        path = REPO_ROOT / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--capture",
        action="store_true",
        help="explicitly replace committed golden fixtures",
    )
    args = parser.parse_args()
    if args.capture:
        capture()
        print(f"captured {len(capture_documents())} deterministic golden files")
        return 0

    errors = verify()
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print("Phase 0D migration golden fixtures verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
