/* ------------------------------------------------------------------ */
/*  Envelope response parsers for databases, artifacts, skills         */
/*  Declarative manifest validators live in apiDeclarativeParsers.ts.  */
/* ------------------------------------------------------------------ */

import { APIError } from "@/hooks/settingsContracts";
import type { SkillDetail, SkillManifest, SkillValidation } from "@/hooks/settingsContracts";
import type { ArtifactRecord, DatabaseRecord } from "@/runtime/contracts";
import { assertOrigin, assertPackageKind, assertSkillManifest, assertDeclarativeManifest } from "@/lib/apiDeclarativeParsers";
import {
  assertString, assertBoolean, assertStringOrNull, assertNumber, assertObject, assertArray,
  optBoolean,
} from "@/lib/eventValidatorHelpers";

export { assertDeclarativeManifest } from "@/lib/apiDeclarativeParsers";

/* ---- Databases ---- */

export function parseDatabasesEnvelope(json: unknown): { databases: DatabaseRecord[] } {
  const obj = assertObject(json, "databases response");
  return {
    databases: assertArray(Reflect.get(obj, "databases"), "databases", (item, i) => {
      const dbo = assertObject(item, `databases[${i}]`);
      return {
        id: assertString(Reflect.get(dbo, "id"), `databases[${i}].id`),
        name: assertString(Reflect.get(dbo, "name"), `databases[${i}].name`),
        category: assertString(Reflect.get(dbo, "category"), `databases[${i}].category`),
        description: assertString(Reflect.get(dbo, "description"), `databases[${i}].description`),
        available: optBoolean(Reflect.get(dbo, "available"), `databases[${i}].available`),
        origin: (() => { const o = Reflect.get(dbo, "origin"); return o !== undefined ? assertOrigin(o, `databases[${i}].origin`) : undefined; })(),
        version: (() => { const v = Reflect.get(dbo, "version"); return v !== undefined ? assertString(v, `databases[${i}].version`) : undefined; })(),
        pipeline_supported: optBoolean(Reflect.get(dbo, "pipeline_supported"), `databases[${i}].pipeline_supported`),
      };
    }),
  };
}

/* ---- Artifacts ---- */

export function parseArtifactsEnvelope(json: unknown): { artifacts: ArtifactRecord[] } {
  const obj = assertObject(json, "artifacts response");
  return {
    artifacts: assertArray(Reflect.get(obj, "artifacts"), "artifacts", (item, i) => {
      const ao = assertObject(item, `artifacts[${i}]`);
      return {
        artifact_id: assertString(Reflect.get(ao, "artifact_id"), `artifacts[${i}].artifact_id`),
        name: assertString(Reflect.get(ao, "name"), `artifacts[${i}].name`),
        size: assertNumber(Reflect.get(ao, "size"), `artifacts[${i}].size`),
        sha256: assertString(Reflect.get(ao, "sha256"), `artifacts[${i}].sha256`),
        media_type: assertString(Reflect.get(ao, "media_type"), `artifacts[${i}].media_type`),
      };
    }),
  };
}

/* ---- Skills ---- */

export function parseSkillsEnvelope(json: unknown): { skills: SkillManifest[] } {
  const obj = assertObject(json, "skills response");
  return {
    skills: assertArray(Reflect.get(obj, "skills"), "skills", (item, i) => {
      const so = assertObject(item, `skills[${i}]`);
      return {
        name: assertString(Reflect.get(so, "name"), `skills[${i}].name`),
        display_name: assertString(Reflect.get(so, "display_name"), `skills[${i}].display_name`),
        version: assertString(Reflect.get(so, "version"), `skills[${i}].version`),
        category: assertString(Reflect.get(so, "category"), `skills[${i}].category`),
        description: assertString(Reflect.get(so, "description"), `skills[${i}].description`),
        origin: assertOrigin(Reflect.get(so, "origin"), `skills[${i}].origin`),
        supported_sources: assertArray(Reflect.get(so, "supported_sources"), `skills[${i}].supported_sources`, (v) => assertString(v, `skills[${i}].supported_sources[]`)),
        operations: assertArray(Reflect.get(so, "operations"), `skills[${i}].operations`, (v) => assertString(v, `skills[${i}].operations[]`)),
        enabled: assertBoolean(Reflect.get(so, "enabled"), `skills[${i}].enabled`),
        user_selectable: assertBoolean(Reflect.get(so, "user_selectable"), `skills[${i}].user_selectable`),
        pipeline_supported: assertBoolean(Reflect.get(so, "pipeline_supported"), `skills[${i}].pipeline_supported`),
        available: optBoolean(Reflect.get(so, "available"), `skills[${i}].available`),
        load_error: assertLoadError(Reflect.get(so, "load_error"), `skills[${i}].load_error`),
      };
    }),
  };
}

function assertLoadError(v: unknown, path: string): string | null | undefined {
  if (typeof v === "string") return v;
  if (v === null) return null;
  if (v === undefined) return undefined;
  throw new APIError(502, `Expected string|null|undefined at ${path}, got ${typeof v}`);
}

export function parseSkillDetail(json: unknown): SkillDetail {
  const obj = assertObject(json, "SkillDetail");
  const manifest = assertObject(Reflect.get(obj, "manifest"), "manifest");
  return {
    manifest: assertSkillManifest(manifest, "manifest"),
    current_version: assertString(Reflect.get(obj, "current_version"), "current_version"),
    versions: assertArray(Reflect.get(obj, "versions"), "versions", (v) => assertString(v, "versions[]")),
    package_kind: assertPackageKind(Reflect.get(obj, "package_kind"), "package_kind"),
    warning: assertStringOrNull(Reflect.get(obj, "warning"), "warning"),
    available: assertBoolean(Reflect.get(obj, "available"), "available"),
    load_error: assertStringOrNull(Reflect.get(obj, "load_error"), "load_error"),
    declarative_manifest: assertDeclarativeManifest(Reflect.get(obj, "declarative_manifest"), "declarative_manifest"),
  };
}

export function parseSkillValidation(json: unknown): SkillValidation {
  const obj = assertObject(json, "SkillValidation");
  const skill = assertObject(Reflect.get(obj, "skill"), "skill");
  return {
    valid: assertBoolean(Reflect.get(obj, "valid"), "valid"),
    skill: assertSkillManifest(skill, "skill"),
    warning: assertStringOrNull(Reflect.get(obj, "warning"), "warning"),
  };
}
