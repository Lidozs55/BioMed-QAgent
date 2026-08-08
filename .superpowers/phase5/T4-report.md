# T4 Report — ValueScale + normalization identity + required_entity_level

**Phase**: 5 (GEO migration) · **Task**: T4 (spec D2/D3/D4: ValueScale, normalization identity, profile entity level)
**Branch**: `feat/phase5-t4-valuescale` (isolated worktree; base = T3 `245faf3` — merge into `feat/phase5-geo-migration` pending)
**Status**: DONE — all gates green

## Deliverables

1. **`NormalizationProfile.allowed_value_scales: list[ValueScale]`** —
   required, non-empty allowlist (`Field(min_length=1)`, no default) on
   `backend/app/datasets/contracts.py`. A profile without the allowlist is a
   contract error (rejected by pydantic). The canonicalizer rejects any row
   whose declared `value_scale` is not a `ValueScale` member **or** is not in
   the profile's allowlist with the typed reason `unknown_scale` (audit CSV).
   `unknown` is honest but must be explicitly allowed; it is **never**
   promoted to a known scale (log2) by inference.

2. **Identity primitives** — new module
   `backend/app/datasets/build/identity.py`: frozen `MeasurementIdentity`
   dataclass for the fixed ordered triple
   `(value_semantics, value_scale, expression_unit)` with `order=True` stable
   sorting, `serialize()` (the T2 batch-statistics list form) and
   `deserialize()` (validating the scale via `ValueScale`). `raw_count` is
   rejected as a scale (`ValueScale("raw_count")` raises). T5's gate matrix
   consumes these primitives.

3. **Canonicalizer scale validation** — `backend/app/datasets/build/
   canonicalizer.py` now parses the declared scale per row (`ValueScale(...)`),
   rejects unparseable/unauthorized scales as `unknown_scale`, and collects
   the measurement identity from the **validated** scale (no string drift
   between validation and identity). `measurement_identities` statistics keep
   the exact T2 serialized format.

4. **`ValidationProfile.required_entity_level: Literal["gene","probe","any"]`**
   — required server-side field on the contract. `gene_expression.release.v1`
   declares `"gene"`; new `gene_expression.probe_release.v1` profile
   (`ProbeExpressionValidationProfile` in `profiles.py`) declares `"probe"`
   and shares the same release checks (coverage/entity matrix itself is T5).

5. **Spec Validator entity-level compatibility** —
   `backend/app/datasets/spec_validator.py` resolves the selected validation
   profile's `required_entity_level` (`get_validation_profile`; unresolvable
   profile degrades to unconstrained — the allowlist already gates
   admission). New reason code **`entity_level_profile_mismatch`**: explicit
   `target_entity_level` ≠ profile `required_entity_level` →
   `invalid_input` (gene build + probe profile, probe build + gene profile).
   Unset `target_entity_level` derives from the profile; a profile-required
   level inconsistent with the schema granularity is rejected as
   `entity_level_schema_mismatch` (probe profile + gene schema, gene profile
   + probe schema).

6. **GDC/Xena stay green** — `gene_expression.normalization.v1` declares all
   four scales explicitly (GDC/Xena emit `linear`; GEO emits `log2`/
   `unknown`/`linear`); canonical output unchanged (serialized identity list
   identical to T2's format, verified by the untouched GDC/Xena tests).

## Red-first tests (21 new)

- `tests/test_dataset_identity.py` (5, new file) — triple members; stable
  serialize/deserialize round trip; stable ordering across semantics/scale/
  unit; `raw_count` rejected as a scale (contract + deserialize); `unknown`
  serializes honestly.
- `tests/test_dataset_contracts.py` (+8) — profile without scale allowlist
  rejected; empty allowlist rejected; members accepted; string coercion;
  non-`ValueScale` literal rejected; `required_entity_level` required;
  value set {gene,probe,any}; unknown literal rejected.
- `tests/test_dataset_canonicalizer.py` (+3) — scale outside allowlist
  rejected (`unknown` with {log2,linear} only → `unknown_scale`); `unknown`
  accepted when explicitly allowed and never promoted (canonical rows +
  identity stay `unknown`); raw `raw_count` string in a parsed row rejected
  (defense in depth beyond typed AdapterParams).
- `tests/test_dataset_profiles.py` (+3) — gene profile declares `"gene"`
  (class + contract); probe profile registered with `"probe"` + same
  acceptance policy; probe profile runs the shared release gate.
- `tests/test_spec_validator.py` (+2 new + 2 re-derived) — gene build +
  probe profile rejected (`entity_level_profile_mismatch`); probe build +
  gene profile rejected; unset target derives from profile (gene+gene OK,
  probe+probe OK, gene profile + probe schema invalid, probe profile + gene
  schema invalid). T1's `test_unset_target_entity_level_is_always_consistent`
  re-derived to D4 semantics; `test_probe_schema_selectable_...` now selects
  the probe profile.

## Verification

- `pytest -q` (backend): **2539 passed**, 2 skipped, 28 deselected (baseline
  2518; +21 new).
- `ruff check app/ tests/ launcher.py`: clean.
- `python -c "import app.main"`: OK.
- Frontend untouched. T2/T3-owned files untouched; `canonicalizer.py` scale
  validation, `contracts.py`, `profiles.py`, `spec_validator.py` are T4's
  seams per the task brief.

## Notes / seams for later tasks

- **T5 owns the gate matrix**: `compat_gate.py` was not modified — the
  unknown×unknown FAIL, log2/linear and entity-level matrices land in T5 and
  consume `MeasurementIdentity.deserialize` + the `measurement_identities`
  statistics (unchanged T2 format).
- **`required_entity_level="any"`** is accepted by the contract and treated as
  unconstrained by the Spec Validator; no registered profile uses it yet.
- **Profile `validate()` is schema-driven, not entity-policy-driven** — the
  probe profile runs the same release checks; entity-level consistency is
  enforced by the Spec Validator (D4), not by the profile's `validate()`.
- An allowed-but-unregistered validation profile degrades to unconstrained
  entity level (allowlist still gates admission); documented in
  `_profile_entity_level`.

## Commits

- T4 (this task): `feat(phase5): T4 ValueScale + normalization identity + required_entity_level — allowed_value_scales, scale validation, probe_release.v1 profile, spec/profile compatibility (TDD)`
