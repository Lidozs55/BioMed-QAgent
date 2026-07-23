# Task 7 — DashScope Context-Budget Estimator Live Comparison

## Scope

`backend/tests/live/test_context_budget_estimator_live.py` compares one fixed
synthetic bilingual Chat Completions request against the final authoritative
streamed `usage.prompt_tokens` result. It uses the existing
`PromptTokenEstimator`, prompt-shape/tool-schema serializers, context budget,
and calibration store. It sends a provider request only after the credential
guard and requests `stream_options={"include_usage": True}`.

The fixture is bound to the supported catalog model `qwen-plus` at the official
DashScope-compatible endpoint. It resolves the budget with no context-window
override and asserts the catalog capacity of `131072` tokens. The live request
reserves `max_tokens=1`.

`backend/tests/conftest.py` now deselects `@pytest.mark.live` only when pytest
was invoked with no marker expression and no direct `tests/live/...` target.
It does not parse marker expressions: every non-empty `-m` is passed through to
pytest unchanged.

## RED Evidence

### Marker expression

Before the marker repair:

```text
uv run pytest -m "live or other" --collect-only -q
```

Result:

```text
no tests collected (1490 deselected) in 4.07s
```

The previous hook recognized only the literal expression `live`, then
incorrectly deselected live tests for composite expressions.

### Fixed catalog model

Before binding the live request to `qwen-plus`:

```text
uv run pytest -m "live or other" tests/live/test_context_budget_estimator_live.py -v
```

Result:

```text
FAILED
assert 'qwen3.6-flash' == 'qwen-plus'
1 failed in 1.81s
```

The existing test combined the configured model with an invented 32,768-token
override, so it did not test catalog metadata for the request model.

## GREEN Evidence

The repaired test independently probes `dashscope.get_tokenizer("qwen-plus")`
locally before building the counter:

- import missing or exact `UnsupportedModel` -> require conservative counter
  and the exact UTF-8-byte plus structural formula;
- tokenizer returned -> require `qwen_local`, a
  `DashScopeLocalTokenizerAdapter`, and equal local encode/count semantics;
- other errors propagate and fail the test rather than being reclassified as
  unsupported.

The probe calls neither `Tokenization.call` nor any provider request, download,
or remote tokenizer endpoint.

## Verification

All commands ran from `backend/` in
`D:\coding\BioMed-QAgent\.worktrees\fix-model-aware-context-budget`.

1. Default deselection proof:

   ```text
   uv run pytest -q -k "canonical_json or context_budget_estimator"
   ```

   ```text
   1 passed, 1489 deselected in 4.60s
   ```

   The selected non-live canonical JSON test ran; the marked estimator test was
   deselected before its credential guard, SDK probe, or provider client.

2. Exact marker expression:

   ```text
   uv run pytest -m live --collect-only -q -k context_budget_estimator
   ```

   ```text
   tests/live/test_context_budget_estimator_live.py::test_context_budget_estimator_matches_authoritative_prompt_usage

   1/1490 tests collected (1489 deselected) in 4.60s
   ```

3. Non-live marker expression:

   ```text
   uv run pytest -m "not live" --collect-only -q -k canonical_json
   ```

   ```text
   tests/test_token_estimation.py::test_canonical_json_sorts_dict_keys_and_remains_compact

   1/1490 tests collected (1489 deselected) in 4.48s
   ```

4. Composite marker expression:

   ```text
   uv run pytest -m "(live or other)" --collect-only -q -k context_budget_estimator
   ```

   ```text
   tests/live/test_context_budget_estimator_live.py::test_context_budget_estimator_matches_authoritative_prompt_usage

   1/1490 tests collected (1489 deselected) in 4.43s
   ```

5. Direct-file collection:

   ```text
   uv run pytest tests/live/test_context_budget_estimator_live.py --collect-only -q
   ```

   ```text
   tests/live/test_context_budget_estimator_live.py::test_context_budget_estimator_matches_authoritative_prompt_usage

   1 test collected in 1.30s
   ```

6. Default live run:

   ```text
   uv run pytest -m live tests/live/test_context_budget_estimator_live.py -v -s
   ```

   ```text
   tokenizer_kind=qwen_local
   1 passed in 3.60s
   ```

7. Optional tokenizer extra:

   ```text
   uv run --extra qwen-tokenizer pytest -m live tests/live/test_context_budget_estimator_live.py -v -s
   ```

   ```text
   tokenizer_kind=qwen_local
   1 passed in 3.73s
   ```

The optional tokenizer was locally available in both recorded environments, so
both live runs exercised and proved the `qwen_local` branch. In an environment
where the optional package is absent or `qwen-plus` raises `UnsupportedModel`,
the same test requires the conservative branch instead.

8. Ruff:

   ```text
   uv run ruff check tests/live/test_context_budget_estimator_live.py tests/conftest.py
   ```

   ```text
   All checks passed!
   ```

9. LSP diagnostics:

   ```text
   backend/tests/live/test_context_budget_estimator_live.py: No diagnostics found
   backend/tests/conftest.py: No diagnostics found
   ```

## Credential Behavior

Without `DASHSCOPE_API_KEY`, the test explicitly skips before it probes the
tokenizer, builds `ModelConfiguration`, selects a counter, creates
`AsyncOpenAI`, or sends any request. This report records no credential, header,
or credential-bearing URL.
