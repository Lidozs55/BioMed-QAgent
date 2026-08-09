"""V1 artifact-surface bridge for V2 builds (Phase 7 T2 dual-write).

After a successful V2 build, the published outputs are committed to the
content-addressed ``DatasetCacheV2``. During the Phase 7 transition, the
same build is additionally mirrored onto the legacy V1 artifact surface
(``<task_root>/artifacts/`` + a V1-compatible ``run_manifest.json``) so
filesystem-level consumers and the legacy artifact API keep working.

Design notes:

- The bridge writes the manifest **last**: a crash mid-copy leaves no
  ``run_manifest.json``, and the legacy artifact API treats a missing
  manifest as "no artifacts" (safe) rather than a 409 conflict.
- No ``.runtime-publication.json`` marker is written. A marker would make
  the runtime startup reconcile loop synthesize a fake ``pub-<run_id>``
  publication record for the build (the marker is the V1 pipeline's
  publication signal); the bridge deliberately writes only files + manifest
  and the legacy artifact API serves the surface in degraded mode once the
  run is COMPLETED.
- This is a best-effort adapter, not a new engine: failures are logged by
  the caller and never fail the build.
"""
from __future__ import annotations

import hashlib
import logging
import shutil
from datetime import UTC, datetime
from pathlib import Path

from app.datasets.contracts import DatasetManifest
from app.domain.contracts import (
    ArtifactManifestEntry,
    RunManifest,
    TaskRequest,
    TaskSpecification,
    TaskState,
    ValidationSummary,
)
from app.domain.contracts.dataset_state import ArtifactRole

logger = logging.getLogger(__name__)

#: Marks a bridged (V2-origin) manifest; V1 pipeline manifests use 0.1.0.
_BRIDGE_PIPELINE_VERSION = "0.2.0"
_BRIDGE_GENERATED_BY_STEP = "step_dataset_build_v2"

#: The legacy artifact API serves this pseudo artifact id for the manifest.
_MANIFEST_ARTIFACT_ID = "dataset_manifest"


def mirror_build_to_legacy_artifacts(
    *,
    task_id: str,
    task_root: Path,
    build_dir: Path,
    objective: str,
) -> Path | None:
    """Mirror one completed V2 build onto the task's legacy artifact surface.

    Copies the manifest-registered artifacts (plus ``dataset_manifest.json``)
    into ``<task_root>/artifacts/`` and writes a valid V1 ``run_manifest.json``
    describing them. Returns the artifacts directory, or ``None`` when the
    build has no manifest to bridge.
    """

    manifest_path = build_dir / "dataset_manifest.json"
    if not manifest_path.is_file():
        return None
    manifest = DatasetManifest.model_validate_json(manifest_path.read_text("utf-8"))

    artifacts_dir = task_root / "artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    entries: list[ArtifactManifestEntry] = []
    for artifact in manifest.artifacts:
        src = build_dir / artifact.relative_path
        if not src.is_file():
            # Best-effort: a missing file must never fail the build; it is
            # simply not mirrored (the cache commit already surfaced it).
            logger.warning(
                "V1 bridge skipped missing artifact %s for build %s",
                artifact.relative_path,
                manifest.build_id,
            )
            continue
        dest = artifacts_dir / artifact.relative_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        # The V2 content-addressed artifact ids are not unique across
        # relative paths (the same file content can appear at two paths), so
        # the V1 surface derives a path-unique id (V1 style).
        artifact_id = (
            f"artifact_"
            f"{hashlib.sha256(artifact.relative_path.encode('utf-8')).hexdigest()[:32]}"
        )
        entries.append(
            ArtifactManifestEntry(
                artifact_id=artifact_id,
                role=artifact.role,
                name=Path(artifact.relative_path).name,
                relative_path=f"artifacts/{artifact.relative_path}",
                media_type=artifact.media_type,
                size_bytes=artifact.size_bytes,
                sha256=artifact.sha256,
                generated_by_step_id=_BRIDGE_GENERATED_BY_STEP,
            )
        )

    manifest_dest = artifacts_dir / "dataset_manifest.json"
    shutil.copy2(manifest_path, manifest_dest)
    entries.append(
        ArtifactManifestEntry(
            artifact_id=_MANIFEST_ARTIFACT_ID,
            role=ArtifactRole.SCHEMA,
            name="dataset_manifest.json",
            relative_path="artifacts/dataset_manifest.json",
            media_type="application/json",
            size_bytes=manifest_dest.stat().st_size,
            # The legacy integrity check hashes the FILE, so the entry must
            # carry the file's digest — not ``manifest.sha256`` (a content
            # summary digest over artifact pairs, which never equals the
            # file hash and made every mirrored legacy surface fail the
            # artifact API integrity check with 409).
            sha256=hashlib.sha256(manifest_dest.read_bytes()).hexdigest(),
            generated_by_step_id=_BRIDGE_GENERATED_BY_STEP,
        )
    )
    entries.sort(key=lambda entry: entry.artifact_id)

    finished_at = datetime.now(UTC)
    run_manifest = RunManifest(
        task_id=task_id,
        id_generation_version="1.0",
        request=TaskRequest(topic=objective, mode="fixture"),
        specification=TaskSpecification(topic=objective),
        task_state=TaskState.COMPLETED,
        stage_attempt_ids=[],
        source_ids=sorted(manifest.source_summary),
        artifacts=entries,
        validation=ValidationSummary(
            status="valid",
            checked_count=0,
            failed_count=0,
            report_path="validation_report.json",
        ),
        pipeline_version=_BRIDGE_PIPELINE_VERSION,
        mode="fixture",
        live_accepted=False,
        started_at=finished_at,
        finished_at=finished_at,
    )
    (artifacts_dir / "run_manifest.json").write_text(
        run_manifest.model_dump_json(indent=2) + "\n",
        "utf-8",
    )
    logger.info(
        "V1 bridge mirrored build %s artifacts for task %s (%d files)",
        manifest.build_id,
        task_id,
        len(entries),
    )
    return artifacts_dir
