"""Architecture-level release invariant tests (ADR-012; Design §16 Phase 6)."""

from __future__ import annotations

import json
from pathlib import Path

from app.datasets.build.hashing import sha256_file
from app.datasets.build.invariants import check_release_invariants
from app.datasets.contracts import (
    ArtifactRole,
    DatasetManifest,
    ManifestArtifactEntry,
    ValidationResult,
    ValidationResultStatus,
)

_DIGEST = "a" * 64
_PRIMARY_CONTENT = b"gene_id\texpression_value\nTP53\t1.5\n"


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


def _materialize_primary(output_dir: Path) -> Path:
    path = output_dir / "merged" / "primary.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_PRIMARY_CONTENT)
    return path


def _entry(
    output_dir: Path,
    artifact_id: str,
    role: ArtifactRole,
    path: Path,
    media_type: str = "text/csv",
) -> ManifestArtifactEntry:
    return ManifestArtifactEntry(
        artifact_id=artifact_id,
        role=role,
        relative_path=path.relative_to(output_dir).as_posix(),
        media_type=media_type,
        size_bytes=path.stat().st_size,
        sha256=sha256_file(path),
    )


def _manifest(
    output_dir: Path,
    *,
    source_count: int = 2,
    with_provenance_artifact: bool = True,
    provenance_relpath: str = "provenance.json",
) -> DatasetManifest:
    primary = _materialize_primary(output_dir)
    entries = [
        _entry(
            output_dir,
            "artifact_primary",
            ArtifactRole.PRIMARY_DATASET,
            primary,
        )
    ]
    if with_provenance_artifact:
        provenance = output_dir / provenance_relpath
        if provenance.is_file():
            entries.append(
                _entry(
                    output_dir,
                    "artifact_prov",
                    ArtifactRole.PROVENANCE,
                    provenance,
                    media_type="application/json",
                )
            )
        else:
            # Declared artifact whose file is absent (missing-on-disk case).
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
    assert result.artifacts_intact
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


def test_manifest_artifact_missing_fails(tmp_path: Path) -> None:
    """B4: every manifest artifact must exist on disk before promotion."""
    output_dir = _build_dir(tmp_path)
    _provenance_path(output_dir)
    manifest = _manifest(output_dir)
    (output_dir / "merged" / "primary.csv").unlink()
    result = check_release_invariants(
        manifest=manifest,
        validation=_validation(),
        output_dir=output_dir,
    )
    assert not result.passed
    assert not result.artifacts_intact
    assert any(
        "merged/primary.csv" in v and "missing" in v for v in result.violations
    )


def test_manifest_artifact_tampered_size_or_hash_fails(tmp_path: Path) -> None:
    """B4: a manifest artifact edited after validation (size/hash change) must
    fail the release gate before promotion."""
    output_dir = _build_dir(tmp_path)
    _provenance_path(output_dir)
    manifest = _manifest(output_dir)
    (output_dir / "merged" / "primary.csv").write_bytes(b"tampered-with-data!!")
    result = check_release_invariants(
        manifest=manifest,
        validation=_validation(),
        output_dir=output_dir,
    )
    assert not result.passed
    assert not result.artifacts_intact
    assert any(
        "size" in v or "sha256 mismatch" in v for v in result.violations
    )


def test_provenance_same_count_fake_source_ids_fail(tmp_path: Path) -> None:
    """B4: the provenance source asset ids must equal the build's source-asset
    set exactly — a same-count set of different ids must fail the gate."""
    output_dir = _build_dir(tmp_path)
    _provenance_path(output_dir, source_count=2)  # asset_0..., asset_1...
    result = check_release_invariants(
        manifest=_manifest(output_dir),
        validation=_validation(),
        output_dir=output_dir,
        expected_source_asset_ids={
            "real_asset_a" + "0" * 54,
            "real_asset_b" + "0" * 54,
        },
    )
    assert not result.passed
    assert not result.provenance_closed
    assert any(
        "do not match the build's source asset set" in v for v in result.violations
    )


def test_provenance_exact_source_ids_pass(tmp_path: Path) -> None:
    """The exact build source-asset set satisfies the closure gate."""
    output_dir = _build_dir(tmp_path)
    _provenance_path(output_dir, source_count=2)
    result = check_release_invariants(
        manifest=_manifest(output_dir),
        validation=_validation(),
        output_dir=output_dir,
        expected_source_asset_ids={
            "asset_0" + "0" * 56,
            "asset_1" + "0" * 56,
        },
    )
    assert result.passed
    assert result.provenance_closed
