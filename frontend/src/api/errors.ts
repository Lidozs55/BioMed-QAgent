/**
 * Frontend API error surface.
 *
 * The error type itself lives in ``@biomed/contracts`` (shared with the wire
 * parsers); this module is the frontend-side import home so UI/hook code
 * never reaches into the hooks directory for protocol errors.
 */
export { APIError, normalizeErrorDetail } from "@biomed/contracts";
