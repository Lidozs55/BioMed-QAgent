# Phase 6 TypeScript Model Settings

Phase 6 moves the browser-facing model settings and provider/model registry to
the TypeScript Application Host. The frontend wire API remains compatible:
`/api/v1/settings`, `/api/v1/vendors`, `/api/v1/models`, and
`/api/v1/model-registry/*` are now Host-owned before formal runtime or legacy
proxy routing.

## Persistence

The Host stores public model metadata in `settings/model-registry.json` and
credentials in the separate `settings/model-auth.json` file. API responses only
return a masked key and `api_key_configured`; the public registry never contains
credential text. Writes use a temporary file followed by atomic rename.

On first startup, the Host imports `settings/model.json` and
`settings/model_registry.db`. The registry JSON records completion with
`legacy_registry_migrated_at`, so later startups do not duplicate rows. The
SQLite database remains untouched for legacy rollback and is not a runtime
dependency after import.

## Pi Adapter

Every new Pi session resolves one immutable active-model snapshot from the TS
settings service. The adapter registers the selected OpenAI-compatible provider
with Pi `ModelRuntime`, installs its API key through the runtime credential API,
and applies the selected context window, output-token limit, and temperature to
provider requests. Existing sessions keep their captured model; setting changes
apply to the next session.

## Safety And Rollback

Provider discovery rejects embedded credentials, credentialed HTTP endpoints,
localhost/private/link-local DNS results, and redirects. The TS Host profile
uses the new service automatically. Full legacy rollback still starts FastAPI
directly and continues reading the untouched Python settings files/database.
