"""Architecture-level release invariant tests (ADR-012; Design §16 Phase 6)."""

from __future__ import annotations

import json
from pathlib import Path

from app.datasets.build.invariants import (
    check_release_invariants,
    find_latest_publication,
)
from app.datasets.contracts import (
    ArtifactRole,
    DatasetManifest,
    ManifestArtifactEntry,
    ValidationResult,
    ValidationResultStatus,
)

_DIGEST = "a" * 64


def _provenance_path(output_dir: Path, source_count: int = 2) -> Path:
    path = output_dir / "provenance.json"
    path.write_text(
        json.dumps(
            {
                "schema_ref": "gene_expression.long.v1",
                "sources": [
                    {
                        "binding_id": f"binding_{i}",
                        "asset_id": f"asset_{i}" + "0" * 56,
                        "source_id": f"src_{i}",
                        "logical_file": f"f{i}.tsv",
                        "sha256": _DIGEST,
                    }
                    for i in range(source_count)
                ],
            },
            ensure_ascii=False,
        ),
        "utf-8",
    )
    return path


def _manifest(
    output_dir: Path,
    *,
    source_count: int = 2,
    with_provenance_artifact: bool = True,
    provenance_relpath: str = "provenance.json",
) -> DatasetManifest:
    entries = [
        ManifestArtifactEntry(
            artifact_id="artifact_primary",
            role=ArtifactRole.PRIMARY_DATASET,
            relative_path="merged/primary.csv",
            media_type="text/csv",
            size_bytes=10,
            sha256=_DIGEST,
        )
    ]
    if with_provenance_artifact:
        entries.append(
            ManifestArtifactEntry(
                artifact_id="artifact_prov",
                role=ArtifactRole.PROVENANCE,
                relative_path=provenance_relpath,
                media_type="application/json",
                size_bytes=10,
                sha256=_DIGEST,
            )
        )
    return DatasetManifest(
        manifest_id="manifest_test",
        task_id="task_test",
        build_id="build_test",
        dataset_family="gene_expression",
        row_granularity="gene_sample_measurement",
        schema_ref="gene_expression.long.v1",
        row_count=4,
        sha256=_DIGEST,
        artifacts=entries,
        provenance_summary={"source_count": source_count},
    )


def _validation(status: ValidationResultStatus = ValidationResultStatus.PASSED) -> ValidationResult:
    return ValidationResult(
        manifest_digest=_DIGEST,
        profile_ref="gene_expression.release.v1",
        status=status,
        checked_count=8,
        failed_count=0 if status is ValidationResultStatus.PASSED else 1,
    )


def _build_dir(tmp_path: Path) -> Path:
    output_dir = tmp_path / "build"
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def test_all_three_invariants_pass(tmp_path: Path) -> None:
    output_dir = _build_dir(tmp_path)
    _provenance_path(output_dir)
    result = check_release_invariants(
        manifest=_manifest(output_dir),
        validation=_validation(),
        output_dir=output_dir,
    )
    assert result.passed
    assert result.provenance_closed
    assert result.profile_passed
    assert result.atomic_promotion_ready
    assert result.violations == ()


def test_missing_provenance_artifact_fails(tmp_path: Path) -> None:
    output_dir = _build_dir(tmp_path)
    result = check_release_invariants(
        manifest=_manifest(output_dir, with_provenance_artifact=False),
        validation=_validation(),
        output_dir=output_dir,
    )
    assert not result.passed
    assert not result.provenance_closed
    assert any("no provenance artifact" in v for v in result.violations)


def test_provenance_document_missing_on_disk_fails(tmp_path: Path) -> None:
    output_dir = _build_dir(tmp_path)
    result = check_release_invariants(
        manifest=_manifest(output_dir),  # artifact declared, file absent
        validation=_validation(),
        output_dir=output_dir,
    )
    assert not result.passed
    assert not result.provenance_closed
    assert any("missing on disk" in v for v in result.violations)


def test_provenance_source_coverage_fails(tmp_path: Path) -> None:
    """The provenance document must list every source asset."""
    output_dir = _build_dir(tmp_path)
    _provenance_path(output_dir, source_count=1)  # only 1 of 2 sources
    result = check_release_invariants(
        manifest=_manifest(output_dir, source_count=2),
        validation=_validation(),
        output_dir=output_dir,
    )
    assert not result.passed
    assert not result.provenance_closed
    assert any("lists 1 source asset(s)" in v for v in result.violations)


def test_failed_profile_blocks_promotion(tmp_path: Path) -> None:
    output_dir = _build_dir(tmp_path)
    _provenance_path(output_dir)
    result = check_release_invariants(
        manifest=_manifest(output_dir),
        validation=_validation(ValidationResultStatus.FAILED),
        output_dir=output_dir,
    )
    assert not result.passed
    assert not result.profile_passed
    assert any("validation status is 'failed'" in v for v in result.violations)


def test_duplicate_digest_version_blocks_republish(tmp_path: Path) -> None:
    """Atomic promotion must never republish the same immutable version."""
    output_dir = _build_dir(tmp_path)
    _provenance_path(output_dir)
    # Same build + same digest as the manifest under test -> duplicate version.
    duplicate = output_dir / "publish" / f"build_test_{_DIGEST[:16]}"
    duplicate.mkdir(parents=True)
    (duplicate / "dataset_manifest.json").write_text("{}", "utf-8")
    result = check_release_invariants(
        manifest=_manifest(output_dir),
        validation=_validation(),
        output_dir=output_dir,
    )
    assert not result.passed
    assert not result.atomic_promotion_ready
    assert any("refusing to republish" in v for v in result.violations)


def test_new_digest_version_is_allowed(tmp_path: Path) -> None:
    """A newer digest (supersedes) is a different version dir and is allowed."""
    output_dir = _build_dir(tmp_path)
    _provenance_path(output_dir)
    prior = output_dir / "publish" / "build_test_priorversion"
    prior.mkdir(parents=True)
    (prior / "dataset_manifest.json").write_text("{}", "utf-8")
    result = check_release_invariants(
        manifest=_manifest(output_dir),
        validation=_validation(),
        output_dir=output_dir,
    )
    assert result.passed
    assert result.atomic_promotion_ready


def _write_publication(publish_dir: Path, name: str, pub_id: str, published_at: str) -> None:
    version_dir = publish_dir / name
    version_dir.mkdir(parents=True, exist_ok=True)
    (version_dir / "publication.json").write_text(
        json.dumps(
            {
                "publication_id": pub_id,
                "manifest_ref": f"manifest_{name}",
                "validation_result_ref": "validation_report.json",
                "published_at": published_at,
            },
            ensure_ascii=False,
        ),
        "utf-8",
    )


def test_find_latest_publication_uses_published_at_not_lexicographic(tmp_path: Path) -> None:
    """Supersedes targets the newest *time*, even when publication ids sort
    in a different order (same build, multiple digests)."""
    publish_dir = tmp_path / "publish"
    publish_dir.mkdir(parents=True)
    # Lexicographically "pub_build_zzz..." is newest, but it was published
    # *earlier* than "pub_build_aaa..."; time order must win.
    _write_publication(
        publish_dir,
        "build_zzz_1",
        "pub_build_zzz_1",
        "2026-08-07T10:00:00+00:00",
    )
    _write_publication(
        publish_dir,
        "build_aaa_2",
        "pub_build_aaa_2",
        "2026-08-07T11:00:00+00:00",
    )
    assert find_latest_publication(publish_dir) == "pub_build_aaa_2"


def test_find_latest_publication_returns_none_when_empty(tmp_path: Path) -> None:
    publish_dir = tmp_path / "publish"
    publish_dir.mkdir(parents=True)
    assert find_latest_publication(publish_dir) is None


def test_find_latest_publication_skips_corrupt_records(tmp_path: Path) -> None:
    """A broken publication.json must not poison the supersedes chain."""
    publish_dir = tmp_path / "publish"
    publish_dir.mkdir(parents=True)
    _write_publication(
        publish_dir,
        "build_valid",
        "pub_build_valid",
        "2026-08-07T12:00:00+00:00",
    )
    corrupt = publish_dir / "build_corrupt"
    corrupt.mkdir(parents=True)
    (corrupt / "publication.json").write_text("not json", "utf-8")
    # The corrupt record has the *latest* timestamp but is skipped.
    assert find_latest_publication(publish_dir) == "pub_build_valid"
