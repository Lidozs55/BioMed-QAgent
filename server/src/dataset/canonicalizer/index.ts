/**
 * Canonicalizer — deterministic DataBatch normalization (migration plan
 * Phase 4 step 5).  Mirrors ``backend/app/datasets/build/``: the canonicalizer
 * itself, the measurement-identity primitives (``identity.py``), the
 * normalization profile registry (``profiles.py``) and the local symbol map
 * (``gene_maps.py``).
 */

export * from "./identity.js";
export * from "./gene_maps.js";
export * from "./profiles.js";
export * from "./canonicalizer.js";