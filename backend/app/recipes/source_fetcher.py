"""Bridge a ``workflow_recipe`` SourceBinding to a validated SourceAsset.

Design §9.3 — the Acquisition Provider's WorkflowRecipe path. Production
builds only consume PROMOTED recipes; the recipe is pinned by
``recipe_id + recipe_version`` from the SourceBinding and replayed through
:class:`RecipeExecutor`. The staged output is validated and committed through
the workspace before it is handed to a SourceAdapter (Design §8.3).
"""

from __future__ import annotations

from app.datasets.contracts import AcquisitionMode, SourceBinding
from app.recipes.executor import RecipeExecutionResult, RecipeExecutor
from app.recipes.store import WorkflowRecipeStore
from app.subagents.staging import SubagentStagingWorkspace


class WorkflowRecipeSourceFetcher:
    """Acquire one source by replaying a pinned PROMOTED WorkflowRecipe."""

    def __init__(
        self,
        *,
        executor: RecipeExecutor,
        store: WorkflowRecipeStore,
    ) -> None:
        self._executor = executor
        self._store = store

    async def fetch(
        self,
        *,
        binding: SourceBinding,
        workspace: SubagentStagingWorkspace,
    ) -> RecipeExecutionResult:
        """Execute the bound Recipe and return its committed SourceAsset.

        The executor enforces the production boundary: only PROMOTED recipes
        may be replayed. Recipe inputs are taken from the binding's declared
        ``parameters``; the staged output must pass workspace validation
        before it is committed as a task SourceAsset.
        """
        acquisition = binding.acquisition
        if acquisition.mode is not AcquisitionMode.WORKFLOW_RECIPE:
            raise ValueError(
                "WorkflowRecipeSourceFetcher requires workflow_recipe acquisition"
            )
        assert acquisition.recipe_id is not None
        assert acquisition.recipe_version is not None
        recipe = self._store.get(acquisition.recipe_id, acquisition.recipe_version)
        result = await self._executor.execute(
            recipe_id=recipe.recipe_id,
            version=recipe.version,
            inputs=dict(binding.parameters),
            workspace=workspace,
        )
        workspace.validate_source_asset(result.source_asset)
        committed = workspace.commit_source_asset(result.source_asset)
        return RecipeExecutionResult(
            source_asset=committed,
            download_attempt=result.download_attempt,
            attempts=result.attempts,
        )
