"""Phase 5 D6: multi-build orchestration for independent publications.

Each GSE is its own ``DatasetBuildSpec`` (own ``build_id``, bindings,
checkpoint, manifest, validation result and immutable publication) — the
Agent must NEVER stuff multiple GSE bindings into one append/dedup build.
``MultiBuildOrchestrator`` is the server-side orchestration entry point
(the recommended path after V1's multi-GSE explicit raise, and the seam for
the Phase 7 build API):

* input: ``list[DatasetBuildSpec]``; output ``MultiBuildResult`` holding one
  ``BuildExecutionSummary`` per build (build_id / status / ``BuildResult`` /
  publication_id / audit summary — there is deliberately NO ``BuildOutcome``
  concept; ``BuildResult`` is the authoritative business result and the
  summary only aggregates the build_id → BuildResult mapping and failure
  details);
* sequential per-build execution with FAILURE ISOLATION — one GSE failing or
  yielding NO_DATA never rolls back or pollutes the other publications;
* a no-supersede assertion over the batch: a publication of one build_id
  must never supersede a publication of a different build_id. The mechanical
  guarantee is provided by the build-scoped supersede lookup in
  ``ExpressionBuildRunner._publish``; this assertion is the aggregation-level
  defense in depth mandated by D6.

``execute_dataset_build`` (the Agent tool) keeps single-build semantics —
the Agent may call it repeatedly; the orchestrator is the multi-build
service entry.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from pydantic import Field

from app.datasets.contracts import DatasetBuildSpec
from app.domain.contracts.base import ContractModel
from app.domain.contracts.dataset_state import BuildResult, BuildResultStatus


class BuildExecutionSummary(ContractModel):
    """Per-build aggregation inside ``MultiBuildResult`` (Phase 5 D6).

    ``BuildResult`` is the authoritative business outcome; this summary only
    aggregates the build_id → BuildResult mapping, the publication identity
    and failure details. ``status`` is the business ``BuildResultStatus``
    when the build produced one; an execution failure (exception) leaves
    ``status`` None and carries ``error_message``. ``audit_summary`` lists
    the relative paths of the audit artifacts published with the build.
    """

    build_id: str = Field(min_length=1)
    status: BuildResultStatus | None = None
    result: BuildResult | None = None
    publication_id: str | None = None
    supersedes_publication_id: str | None = None
    audit_summary: list[str] = Field(default_factory=list)
    error_message: str | None = None


class MultiBuildResult(ContractModel):
    """Aggregated result of a multi-build orchestration (Phase 5 D6)."""

    builds: list[BuildExecutionSummary] = Field(default_factory=list)


#: Signature of the per-build execution seam the orchestrator aggregates.
#: The callback runs ONE build for the given spec and returns its summary;
#: it is responsible for the real execution (ExpressionBuildRunner +
#: DatasetBuildExecutor wiring, mirroring ``execute_dataset_build``).
RunBuildFn = Callable[[DatasetBuildSpec], Awaitable[BuildExecutionSummary]]


class MultiBuildOrchestrator:
    """Sequential multi-build execution with isolation and no-supersede check.

    ``run_build`` is the injected per-build executor — keeping the
    orchestrator decoupled from the executor wiring so the Phase 7 build API
    and tests can supply their own real (or fake) build runner.
    """

    def __init__(self, run_build: RunBuildFn) -> None:
        self._run_build = run_build

    async def run(self, specs: list[DatasetBuildSpec]) -> MultiBuildResult:
        """Execute every spec sequentially and aggregate the summaries.

        Failure isolation: an exception (or NO_DATA) from one build is
        captured into that build's summary; the remaining builds still run
        and their publications are untouched. After the batch, the
        no-cross-build-supersede assertion is enforced.
        """
        summaries: list[BuildExecutionSummary] = []
        for spec in specs:
            summaries.append(await self._execute_one(spec))
        self._assert_no_cross_build_supersede(summaries)
        return MultiBuildResult(builds=summaries)

    async def _execute_one(self, spec: DatasetBuildSpec) -> BuildExecutionSummary:
        try:
            summary = await self._run_build(spec)
        except Exception as exc:  # failure isolation: never abort the batch
            return BuildExecutionSummary(
                build_id=spec.build_id,
                status=None,
                error_message=str(exc),
            )
        if summary.build_id != spec.build_id:
            raise ValueError(
                f"run_build returned a summary for build {summary.build_id!r} "
                f"but was asked to run {spec.build_id!r}"
            )
        return summary

    @staticmethod
    def _assert_no_cross_build_supersede(
        summaries: list[BuildExecutionSummary],
    ) -> None:
        """Assert that no publication in the batch supersedes a publication
        of a DIFFERENT build (D6).

        A publication may legitimately supersede an older version of ITS OWN
        build (build-scoped supersede chain) or reference an external
        publication outside this batch; only an in-batch cross-build
        reference is a violation.
        """
        owner_by_publication: dict[str, str] = {}
        for summary in summaries:
            if summary.publication_id is not None:
                prior = owner_by_publication.get(summary.publication_id)
                if prior is not None and prior != summary.build_id:
                    raise ValueError(
                        "cross-build supersede: publication "
                        f"{summary.publication_id} is owned by both build "
                        f"{prior!r} and build {summary.build_id!r}"
                    )
                owner_by_publication[summary.publication_id] = summary.build_id
        for summary in summaries:
            superseded = summary.supersedes_publication_id
            if superseded is None:
                continue
            owner = owner_by_publication.get(superseded)
            if owner is not None and owner != summary.build_id:
                raise ValueError(
                    "cross-build supersede: publication "
                    f"{summary.publication_id} (build {summary.build_id!r}) "
                    f"supersedes {superseded} (build {owner!r}); distinct "
                    "builds must never supersede each other"
                )


__all__ = [
    "BuildExecutionSummary",
    "MultiBuildOrchestrator",
    "MultiBuildResult",
    "RunBuildFn",
]
