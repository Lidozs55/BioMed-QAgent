/* ------------------------------------------------------------------ */
/*  Envelope response parsers for databases, artifacts, skills         */
/*  Declarative manifest validators live in apiDeclarativeParsers.ts.  */
/* ------------------------------------------------------------------ */

import type { DatabaseDetail, DatabaseItem, DeclarativeSkillManifest } from "@biomed/contracts";
import type { ArtifactRecord } from "@/runtime/contracts";
import { assertOrigin, assertDeclarativeManifest } from "@/lib/apiDeclarativeParsers";
import {
  assertString, assertNumber, assertObject, assertArray,
  optBoolean,
} from "@biomed/contracts";

/* ---- Databases ---- */

export function parseDatabasesEnvelope(json: unknown): { databases: DatabaseItem[] } {
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
        origin: assertOrigin(Reflect.get(dbo, "origin"), `databases[${i}].origin`),
        version: (() => { const v = Reflect.get(dbo, "version"); return v !== undefined ? assertString(v, `databases[${i}].version`) : undefined; })(),
        pipeline_supported: optBoolean(Reflect.get(dbo, "pipeline_supported"), `databases[${i}].pipeline_supported`),
        enabled: optBoolean(Reflect.get(dbo, "enabled"), `databases[${i}].enabled`) ?? true,
        capability: (() => { const c = Reflect.get(dbo, "capability"); return c !== undefined ? assertString(c, `databases[${i}].capability`) : undefined; })(),
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
        role: assertString(Reflect.get(ao, "role"), `artifacts[${i}].role`),
        size: assertNumber(Reflect.get(ao, "size"), `artifacts[${i}].size`),
        sha256: assertString(Reflect.get(ao, "sha256"), `artifacts[${i}].sha256`),
        media_type: assertString(Reflect.get(ao, "media_type"), `artifacts[${i}].media_type`),
      };
    }),
  };
}

/* ---- Database detail ---- */

export function parseDatabaseDetail(json: unknown): DatabaseDetail {
  const obj = assertObject(json, "database detail");
  const declarative = Reflect.get(obj, "declarative_manifest");
  const manifest: DeclarativeSkillManifest | null =
    declarative === undefined || declarative === null
      ? null
      : assertDeclarativeManifest(declarative, "declarative_manifest");
  return {
    id: assertString(Reflect.get(obj, "id"), "id"),
    name: assertString(Reflect.get(obj, "name"), "name"),
    category: assertString(Reflect.get(obj, "category"), "category"),
    description: assertString(Reflect.get(obj, "description"), "description"),
    available: optBoolean(Reflect.get(obj, "available"), "available"),
    enabled: optBoolean(Reflect.get(obj, "enabled"), "enabled") ?? true,
    origin: assertOrigin(Reflect.get(obj, "origin"), "origin"),
    version: (() => { const v = Reflect.get(obj, "version"); return v !== undefined ? assertString(v, "version") : undefined; })(),
    pipeline_supported: optBoolean(Reflect.get(obj, "pipeline_supported"), "pipeline_supported"),
    capability: (() => { const c = Reflect.get(obj, "capability"); return c !== undefined ? assertString(c, "capability") : undefined; })(),
    declarative_manifest: manifest,
  };
}
