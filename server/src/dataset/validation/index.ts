/**
 * Validation — spec pre-check and versioned validation profiles (migration
 * plan Phase 4 step 8).  Mirrors `backend/app/datasets/spec_validator.py`
 * and the validation registry of `build/profiles.py`.
 */

export * from "./confidence.js";
export * from "./multitable.js";
export * from "./profile.js";
export * from "./spec_validator.js";