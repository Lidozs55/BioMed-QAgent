# AGENTS

## Git integration requirements

- Every `git cherry-pick` invocation must include `-x` so the resulting commit records its source commit. Do not use a plain `git cherry-pick <commit>`.
- Before and after every merge, rebase, or cherry-pick, inspect both commit reachability and effective file/patch differences between the source and target branches.
- Before the operation, state which source commits and changed paths are expected to enter the target, which are already present or patch-equivalent, and which will remain outside the target.
- After the operation, verify and explicitly report which source commits and changes entered the target and which did not. Do not infer inclusion from a successful command alone; use ancestry checks plus tree/patch comparisons.
- If conflicts, patch equivalence, dropped commits, skipped commits, squashing, or an alternate integration strategy change the expected inclusion set, stop and explain the revised inclusion set before continuing.
