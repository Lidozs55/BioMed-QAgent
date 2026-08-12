# Phase 1 Agent Tool and Prompt Migration Matrix

This inventory is frozen from the Main Agent tool list in
`backend/app/agent_loop/agent.py`. Status values are limited to the five Phase 0
categories. The matrix assigns capabilities; it does not require preserving legacy
FunctionTool names when Pi provides a safer native primitive.

## Current Main Agent tools

| Current tool | Status | Phase 1 disposition | Later boundary |
| --- | --- | --- | --- |
| `find_skill` | remove | Do not port the custom catalog-search gateway; use one minimal Pi Skill only to test discovery/load | Business Skill discovery is redesigned during Phase 2 rather than emulating this gateway |
| `invoke_skill` | remove | Do not port the custom invocation gateway | Required business tools move with their Phase 2 Skills |
| `validate_dataset_build_spec` | Phase 1 legacy bridge | Register a Pi tool backed by the named bridge operation of the same name | Replace only when a parity-proven Core owns validation |
| `execute_dataset_build` | Phase 1 legacy bridge | Register a Pi tool backed by the named bridge operation of the same name | Replace only when a parity-proven Core owns execution/publication |
| `request_human_correction` | Phase 2 migrate | Legacy path retains current HIL; the Phase 1 Pi slice reports a typed input-required limitation rather than cloning durable HIL | Integrate Pi input requests with BioMed Run persistence in Phase 2/3 |
| `read_file` | Phase 1 native Pi | Replace with bounded task-relative Workspace read | Remove legacy tool after Pi becomes default |
| `read_file_head` | Phase 1 native Pi | Cover through bounded/offset Workspace read | Remove legacy specialization after parity |
| `search_file` | Phase 1 native Pi | Provide bounded task-relative text search that follows the Workspace read policy | Remove legacy specialization after parity |
| `write_file` | Phase 1 native Pi | Replace with Workspace write restricted to `staging/agent/` | Remove legacy tool after Pi becomes default |
| `list_files` | Phase 1 native Pi | Provide bounded task-relative listing under Workspace read policy | Remove legacy tool after Pi becomes default |
| `compress_query_log` | remove | Do not port the custom query-log compaction workaround | Pi/session context management replaces it; durable conversation compaction is a separate runtime concern |
| `review_query_strategy` | Phase 2 migrate | Keep on the legacy path; it is outside the minimal dataset vertical slice | Reintroduce as a Skill or explicit review service only with an identified consumer |
| `delegate_research` | later/optional | Keep on the legacy path; do not migrate `SubagentSupervisor` | Evaluate Pi child sessions after the single-Agent path is durable |
| `get_subagent_results` | later/optional | Keep on the legacy path | Migrates only with the chosen child-session model |
| `cancel_subagent` | later/optional | Keep on the legacy path | Migrates only with the chosen child-session model |

Phase 1 also introduces native `edit` and development-only `exec` Workspace
capabilities. They are new Pi primitives, not omitted legacy Main Agent tools, and
must obey [the Workspace policy](workspace-policy-phase1.md).

## Frozen minimal Phase 1 prompt constraints

The Phase 1 Pi system prompt and `dataset-construction` Skill contain only these hard
constraints:

1. Formal artifacts can be produced only by the Dataset Core publication path.
2. Agent write and edit operations are restricted to `staging/agent/`.
3. A DatasetBuildSpec must pass `validate_dataset_build_spec` before
   `execute_dataset_build` is called.
4. `NO_DATA`, rejection, cancellation, or failure must not be presented as success.
5. Temporary files and development commands use the governed Task Workspace tools.

These lines guide tool selection; they do not implement Validation, Publication,
path security, or outcome semantics. Full research strategy, source-specific SOPs,
GEO vetting, query review, complete Skill migration, and multi-agent orchestration
remain outside Phase 1.

## Change control

Adding a Phase 1 tool requires updating this matrix, naming its resource owner and
cancellation behavior, and proving it cannot bypass the Dataset Core or Workspace
policy. Copying the legacy long system prompt wholesale is not an accepted migration
shortcut.
