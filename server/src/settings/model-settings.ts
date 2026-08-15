/**
 * Model settings / model registry — public surface.
 *
 * The 37 KB monolith was split by domain into ``./model-registry/``:
 * ``service.ts`` (domain logic), ``routes.ts`` (HTTP routes), ``store.ts``
 * (durable state), ``migration.ts`` (legacy SQLite/JSON migration),
 * ``catalog.ts`` (vendors/param specs/defaults), ``model-resolution.ts``
 * (active model + VLM resolution).
 *
 * This barrel keeps existing importers (bootstrap, tests) unchanged.
 */
export { ModelSettingsService } from "./model-registry/service.js";
export type { ModelSettingsServiceOptions } from "./model-registry/service.js";