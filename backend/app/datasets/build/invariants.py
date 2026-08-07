"""Architecture-level release invariants (ADR-012; Design §16 Phase 6).

Three invariants are fixed at the architecture layer and enforced before any
build output may be promoted:

1. **Provenance closure** — every row of the primary dataset can be traced to
   a source asset through the provenance document; the manifest must carry the
   provenance artifact and the document must list every source asset.
2. **Profile passed** — the versioned Validation Profile gate must have
   PASSED; an unvalidated or failed build is never published.
3. **Atomic promotion** — publication writes a new version without mutating a
   prior version: the publish directory is written via temp-file + rename, and
   a new publication never reuses or rewrites an existing version directory.

Specific rules (CSV encoding, column counts, field completeness, probe
mapping coverage, bbox/model metadata, ...) belong to the versioned Validation
Profile, not to this module — these three invariants are the only
architecture-level gates (Design §16 Phase 6 / Design §17.x).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from app.datasets.contracts import ArtifactRole, DatasetManifest, ValidationResult

#: Directory under the build workspace where immutable publication versions
#: are atomically promoted.
PUBLISH_DIR = "publish"


@dataclass(frozen=True)
class ReleaseInvariantsResult:
    """Outcome of the three-invariant release gate."""

    provenance_closed: bool
    profile_passed: bool
    atomic_promotion_ready: bool
    violations: tuple[str, ...]

    @property
    def passed(self) -> bool:
        return not self.violations


def check_release_invariants(
    *,
    manifest: DatasetManifest,
    validation: ValidationResult,
    output_dir: Path,
) -> ReleaseInvariantsResult:
    """Check the three release invariants for *manifest* + *validation*.

    ``output_dir`` is the build workspace; the provenance document is read
    from disk (its path is taken from the manifest artifact) and the publish
    directory atomic-write mechanism is probed without persisting anything
    meaningful.

    Returns a frozen result; the caller must refuse promotion when
    ``passed`` is False.
    """
    violations: list[str] = []

    provenance_closed = _check_provenance_closure(manifest, output_dir, violations)
    profile_passed = _check_profile_passed(validation, violations)
    atomic_ready = _check_atomic_promotion(manifest, output_dir, violations)

    return ReleaseInvariantsResult(
        provenance_closed=provenance_closed,
        profile_passed=profile_passed,
        atomic_promotion_ready=atomic_ready,
        violations=tuple(violations),
    )


def _check_provenance_closure(
    manifest: DatasetManifest,
    output_dir: Path,
    violations: list[str],
) -> bool:
    provenance_entries = [
        entry for entry in manifest.artifacts
        if entry.role is ArtifactRole.PROVENANCE
    ]
    if not provenance_entries:
        violations.append(
            "provenance closure: manifest declares no provenance artifact"
        )
        return False
    provenance_path = output_dir / provenance_entries[0].relative_path
    if not provenance_path.is_file():
        violations.append(
            f"provenance closure: provenance document missing on disk "
            f"({provenance_entries[0].relative_path})"
        )
        return False
    try:
        document = json.loads(provenance_path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        violations.append(f"provenance closure: provenance document unreadable: {exc}")
        return False
    sources = document.get("sources", [])
    declared_asset_ids = {
        str(source.get("asset_id", ""))
        for source in sources
        if source.get("asset_id")
    }
    source_count = int(manifest.provenance_summary.get("source_count", 0))
    if len(declared_asset_ids) < source_count:
        violations.append(
            "provenance closure: provenance document lists "
            f"{len(declared_asset_ids)} source asset(s) but the manifest "
            f"declares {source_count}"
        )
        return False
    return True


def _check_profile_passed(
    validation: ValidationResult,
    violations: list[str],
) -> bool:
    if validation.status.value != "passed":
        violations.append(
            f"profile passed: validation status is {validation.status.value!r}, "
            "not 'passed'; failed/unvalidated builds are never promoted"
        )
        return False
    return True


def _check_atomic_promotion(
    manifest: DatasetManifest,
    output_dir: Path,
    violations: list[str],
) -> bool:
    publish_dir = output_dir / PUBLISH_DIR
    publish_dir.mkdir(parents=True, exist_ok=True)

    # Probe the temp-file + rename mechanism inside the publish directory.
    probe = publish_dir / ".invariant_probe"
    staged = publish_dir / ".invariant_probe.tmp"
    try:
        staged.write_text("probe", "utf-8")
        staged.replace(probe)
        probe.unlink()
    except OSError as exc:
        violations.append(
            f"atomic promotion: publish directory is not atomically writable: {exc}"
        )
        return False

    # A publication version is content-addressed by build + manifest digest.
    # Atomic promotion forbids republishing the *same* digest (duplicate
    # version) — a new digest names a new version directory, so publishing a
    # newer version never rewrites an older one (supersedes chain).
    version_dir = publish_dir / f"{manifest.build_id}_{manifest.sha256[:16]}"
    if version_dir.exists():
        violations.append(
            "atomic promotion: version directory already exists for this "
            f"digest ({version_dir.name}); refusing to republish an "
            "immutable version"
        )
        return False
    return True


def find_latest_publication(publish_dir: Path) -> str | None:
    """Return the publication_id of the newest immutable version.

    Version directories are content-addressed (``<build_id>_<digest16>``);
    the newest version is the one with the latest ``published_at`` — never a
    lexicographic ordering of publication_ids, which is not a time ordering
    when the same build publishes multiple digests.

    Returns None when no prior publication exists. Corrupt or unreadable
    version records are skipped (a broken record must not poison the
    supersedes chain).
    """
    newest: tuple[str, str] | None = None  # (published_at, publication_id)
    for child in publish_dir.iterdir():
        if not child.is_dir() or child.name.startswith("."):
            continue
        publication_path = child / "publication.json"
        if not publication_path.is_file():
            continue
        try:
            record = json.loads(publication_path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        publication_id = record.get("publication_id")
        if not isinstance(publication_id, str) or not publication_id:
            continue
        published_at = str(record.get("published_at", ""))
        if newest is None or published_at > newest[0]:
            newest = (published_at, publication_id)
    return newest[1] if newest is not None else None
