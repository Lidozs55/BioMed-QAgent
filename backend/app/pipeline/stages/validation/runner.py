"""Validation stage runner: validate, write quality report, publish artifacts.

``run_validation`` is the entry point invoked by the pipeline runner. It calls
``validate_package``, writes ``quality_report.csv``, builds the
``RunManifest``, and (when valid and ``publish=True``) atomically publishes
the staging directory to ``artifacts/``.
"""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

from app.domain.contracts import (
    ArtifactManifestEntry,
    RunManifest,
    StageAttempt,
    TaskRequest,
    TaskState,
)
from app.pipeline.stages.base import (
    ArtifactBuildOutput,
    StageContext,
    StageResult,
    ValidationOutput,
    write_csv,
)
from app.pipeline.stages.validation.checks_common import (
    ARTIFACT_COLUMNS_QUALITY,
    sha256,
)
from app.pipeline.stages.validation.publish import publish_artifacts


def run_validation(
    ctx: StageContext,
    build_output: ArtifactBuildOutput,
    stage_attempts: list[StageAttempt],
    stage_attempt_id: str,
    *,
    publish: bool = True,
) -> StageResult:
    """Validate the staging package and publish artifacts atomically.

    Runs all validation checks, writes ``quality_report.csv``, and if valid
    performs the atomic rename from ``staging/`` to ``artifacts/``.

    ``_validate_package`` is resolved through the package attribute at call
    time (not imported into this module's namespace) so tests that monkeypatch
    ``app.pipeline.stages.validation._validate_package`` still take effect.
    """
    # Local import avoids the package circular import at module load time and
    # ensures the monkeypatchable package attribute is read at call time.
    from app.pipeline.stages.validation import _validate_package

    validation, checks = _validate_package(
        build_output.staging_dir,
        build_output.source_path,
        ctx.workdir.logs / "validation_report.json",
    )
    write_csv(
        build_output.staging_dir / "quality_report.csv",
        ARTIFACT_COLUMNS_QUALITY,
        checks,
    )
    if validation.status != "valid":
        raise ValueError(
            f"validation gate rejected the package: {validation.failed_count} failure(s)"
        )

    entries: list[ArtifactManifestEntry] = []
    for path in sorted(build_output.staging_dir.iterdir(), key=lambda item: item.name):
        checksum_value = sha256(path)
        entries.append(
            ArtifactManifestEntry(
                artifact_id=f"artifact_{checksum_value[:32]}",
                name=path.name,
                relative_path=f"artifacts/{path.name}",
                media_type="text/csv",
                size_bytes=path.stat().st_size,
                sha256=checksum_value,
                generated_by_step_id="step_artifact_builder_v1",
            )
        )
    entries.sort(key=lambda entry: entry.artifact_id)

    manifest = RunManifest(
        task_id=ctx.task_id,
        id_generation_version="1.0",
        request=TaskRequest(topic=build_output.specification.topic, mode=ctx.mode),
        specification=build_output.specification,
        task_state=TaskState.COMPLETED,
        stage_attempt_ids=sorted(
            {attempt.stage_attempt_id for attempt in stage_attempts} | {stage_attempt_id}
        ),
        source_ids=sorted(s.source_id for s in build_output.sources),
        artifacts=entries,
        validation=validation,
        pipeline_version="0.1.0",
        model_name=ctx.model_name,
        mode=ctx.mode,
        live_accepted=ctx.mode == "live" and validation.status == "valid",
        started_at=ctx.started_at,
        finished_at=datetime.now(UTC),
    )
    (build_output.staging_dir / "run_manifest.json").write_text(
        manifest.model_dump_json(indent=2) + "\n", "utf-8"
    )

    ctx.check_cancelled()
    if publish:
        publish_artifacts(build_output.staging_dir, ctx.workdir.artifacts, ctx)

    output = ValidationOutput(
        validation=validation,
        artifacts=entries,
        manifest=manifest,
    )
    digest = hashlib.sha256(
        json.dumps(
            [e.artifact_id for e in entries], separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()
    return StageResult(output_digest=digest, output=output)
