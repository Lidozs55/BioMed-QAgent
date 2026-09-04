# ADR-025: One runtime validation layer and one HTTP/persistence layer per process

## Status

Accepted — 2026-08-14.

## Context

An audit found that wire parsing, HTTP helpers and atomic file persistence were
duplicated across the two processes:

- The frontend had three validator sets (`settingsParsers.ts`,
  `eventValidatorHelpers.ts`, inline copies in `apiResponseParsers.ts`), four
  copies of `parseBuildResult` (three frontend, one in the Dataset Core), and
  `BuildResult` was parsed independently on each side of the wire.
- `frontend/src/hooks/settingsContracts.ts` mixed wire DTOs, model-registry
  types, the `SettingsAPIClient` interface and `APIError`, so event-protocol
  parsing imported from a settings hook directory (layering inverted).
- `product-api.ts` and `model-settings.ts` each implemented their own JSON
  response/body helpers (including a 1 MiB body limit) and their own
  temp-file + rename atomic writes.
- `model-settings.ts` re-implemented SSRF guards (`isPrivateAddress`,
  `publicProviderUrl`) even though `server/src/external/network/url-policy.ts`
  is the stated single bottom-layer policy module for all egress.
- `useAPI.ts` was a 283-line "everything client" mixing transport, query
  building and every endpoint group, and `ResultsViewer` ⇄ `BuildResultsViewer`
  had a circular import via `CsvPreview`.

## Decision

Layer the shared concerns so each lives in exactly one place:

1. `packages/contracts` owns cross-process protocol content:
   - `src/runtime/errors.ts` — `APIError` + `normalizeErrorDetail` (the error
     class is part of the wire contract, needed by shared parsers; the
     frontend re-exports it from `frontend/src/api/errors.ts`).
   - `src/runtime/primitives.ts` — path-based assert/opt helpers.
   - `src/runtime/settings.ts` — settings/personalization/vendors/models parsers.
   - `src/runtime/dataset-build.ts` — canonical `parseBuildResult` wire parser.
   - `src/{settings,model-registry,databases}.ts` — wire DTO types.
   The deterministic Dataset Core keeps its own strict domain validator in
   `server/src/dataset/contracts/` on purpose (`extra="forbid"` exact keys,
   cross-field invariants, `TypeError` semantics) — that is domain validation,
   not wire parsing.
2. `frontend/src/api/` — browser communication: `errors.ts`, `http.ts`
   (transport), per-endpoint modules (`tasks/builds/settings/modelRegistry/
   databases`), `client.ts` (composition, stable `APIClient` type) and
   `types.ts` (`SettingsAPIClient` + DTO re-exports). `hooks/useAPI.ts` is
   memo + re-exports only.
3. `server/src/http/` — `error.ts` (`HttpError`), `body.ts`
   (`readJsonBody`, 1 MiB limit), `response.ts` (`sendJson`/`sendError`/
   `sendNoContent`), `validation.ts` (`asRecord`/`optionalRecord`/
   `requiredString`/`boundedNumber`). `product-api.ts` and
   `model-settings.ts` route through it; oversized/invalid bodies now map to
   413/400/422 instead of 500.
4. `server/src/persistence/atomic-json.ts` — `readJsonFile`/`writeJsonAtomic`.
5. `model-settings.ts` was split by domain into
   `server/src/settings/model-registry/{service,routes,store,migration,catalog,
   model-resolution}.ts`; the old path is a compatibility barrel. SSRF checks
   now reuse `url-policy.ts` (`validatePublicHttpUrl` /
   `validateCredentialedPublicUrl`), with `resolveHost` typed as the shared
   `AddressResolver`.
6. `frontend/src/components/artifacts/` — shared artifact rendering
   (`ArtifactCard`, `BuildArtifactCard`, `CsvPreview`,
   `ArtifactDownloadButton`, `artifactPreview` helpers); the two viewers only
   decide which artifacts to show, breaking the `ResultsViewer` /
   `BuildResultsViewer` cycle.

## Consequences

- Wire shapes and their parsers can no longer drift between the frontend and
  the host; a new endpoint adds its DTO to `@biomed/contracts` and one parser.
- HTTP/JSON/persistence behaviour (limits, status mapping, atomicity) is
  uniform across handlers; `readJsonBody` centralizes the 1 MiB limit.
- Security: egress SSRF policy has one implementation (`url-policy.ts`);
  `model-settings` no longer re-implements guards that could diverge.
- Frontend typecheck footgun fixed: `frontend`'s `tsconfig.json` is a
  `files: []` reference shell, so `tsc --noEmit` type-checked nothing; the
  `tsc`/`typecheck` scripts now run `tsc -b` (project references) which is
  what `pnpm build` already used.
- Known follow-up: model-registry endpoint responses are still narrow-cast in
  `frontend/src/api/modelRegistry.ts` (no wire-boundary validation yet).
  Tracked in `docs/TODO.md`.