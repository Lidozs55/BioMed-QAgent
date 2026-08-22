import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXAMPLE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(EXAMPLE_ROOT, "../../..");
export const INPUT_PATH = "fixtures/input/source-records.json";
export const EXPECTED_PATHS = Object.freeze({
  activities: "fixtures/expected/activities.jsonl",
  compounds: "fixtures/expected/compounds.jsonl",
  assays: "fixtures/expected/assays.jsonl",
  targets: "fixtures/expected/targets.jsonl",
  compound_crosswalks: "fixtures/expected/compound-crosswalks.jsonl",
});

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertRecord(value, pathLabel) {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${pathLabel} must be an object`,
  );
  return value;
}

export function assertString(value, pathLabel) {
  assert(typeof value === "string" && value.length > 0, `${pathLabel} must be a non-empty string`);
  return value;
}

function assertNullableString(value, pathLabel) {
  assert(value === null || typeof value === "string", `${pathLabel} must be a string or null`);
  return value;
}

function assertFiniteNumber(value, pathLabel) {
  assert(typeof value === "number" && Number.isFinite(value), `${pathLabel} must be finite`);
  return value;
}

function assertArray(value, pathLabel) {
  assert(Array.isArray(value), `${pathLabel} must be an array`);
  return value;
}

export async function loadContracts() {
  const requireFromServer = createRequire(path.join(REPOSITORY_ROOT, "server", "package.json"));
  let resolved;
  try {
    resolved = requireFromServer.resolve("@biomed/contracts");
  } catch (error) {
    throw new Error(
      "Cannot resolve the @biomed/contracts public package entry; run pnpm install first",
      { cause: error },
    );
  }
  try {
    return await import(pathToFileURL(resolved).href);
  } catch (error) {
    throw new Error(
      "Cannot load built @biomed/contracts; run pnpm --filter @biomed/contracts build first",
      { cause: error },
    );
  }
}

function stableUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function sortedRows(rows, fields) {
  return [...rows].sort((left, right) => {
    const leftKey = fields.map((field) => String(left[field])).join("\u0000");
    const rightKey = fields.map((field) => String(right[field])).join("\u0000");
    return leftKey.localeCompare(rightKey, "en");
  });
}

function titleCaseToken(value) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)
    .join("_");
}

function assayType(value) {
  const fixed = { B: "binding", F: "functional", A: "ADME" };
  return fixed[value] ?? titleCaseToken(value);
}

export function deriveFixture(inputValue, inputBytes, stableStringify) {
  const input = assertRecord(inputValue, "$input");
  assert(input.schema_version === "1.0", "$input.schema_version must equal 1.0");
  const dataset = assertRecord(input.dataset, "$input.dataset");
  const sourceNamespace = assertString(dataset.source_namespace, "$input.dataset.source_namespace");
  const revisionToken = assertString(dataset.revision_token, "$input.dataset.revision_token");
  const providerSnapshot = assertString(dataset.provider_snapshot, "$input.dataset.provider_snapshot");
  const sources = assertRecord(input.sources, "$input.sources");
  const chembl = assertRecord(sources.chembl, "$input.sources.chembl");
  const pubchem = assertRecord(sources.pubchem, "$input.sources.pubchem");
  const chemblSourceId = assertString(chembl.source_id, "$input.sources.chembl.source_id");
  const pubchemSourceId = assertString(pubchem.source_id, "$input.sources.pubchem.source_id");
  const activitiesInput = assertArray(chembl.activities, "$input.sources.chembl.activities");
  const assaysInput = assertArray(chembl.assays, "$input.sources.chembl.assays");
  const targetsInput = assertArray(chembl.targets, "$input.sources.chembl.targets");
  const pubchemCompounds = assertArray(pubchem.compounds, "$input.sources.pubchem.compounds");
  const crosswalkInput = assertArray(input.crosswalks, "$input.crosswalks");

  const inputSha256 = sha256Hex(inputBytes);
  const sourceAssetId = `asset_${inputSha256}`;

  const activities = activitiesInput.map((rawValue, index) => {
    const raw = assertRecord(rawValue, `$input.sources.chembl.activities[${index}]`);
    const rawValueToken = assertString(raw.value, `$activity[${index}].value`);
    const rawRelation = assertString(raw.relation, `$activity[${index}].relation`);
    const rawUnit = assertString(raw.units, `$activity[${index}].units`);
    const standardizedValueToken = assertString(
      raw.standard_value,
      `$activity[${index}].standard_value`,
    );
    const standardizedValue = Number(standardizedValueToken);
    assert(Number.isFinite(standardizedValue), `$activity[${index}].standard_value must be numeric`);
    const standardizedRelation = assertString(
      raw.standard_relation,
      `$activity[${index}].standard_relation`,
    );
    assert(
      standardizedRelation === rawRelation,
      `$activity[${index}] relation normalization must preserve the source token`,
    );
    return {
      activity_id: assertString(raw.activity_id, `$activity[${index}].activity_id`),
      compound_id: assertString(raw.molecule_chembl_id, `$activity[${index}].molecule_chembl_id`),
      compound_id_namespace: "chembl_compound",
      assay_id: assertString(raw.assay_chembl_id, `$activity[${index}].assay_chembl_id`),
      assay_id_namespace: "chembl_assay",
      target_id: assertString(raw.target_chembl_id, `$activity[${index}].target_chembl_id`),
      target_namespace: "chembl_target",
      activity_type: assertString(raw.standard_type, `$activity[${index}].standard_type`),
      raw_value: rawValueToken,
      raw_relation: rawRelation,
      preserved_relation: rawRelation,
      raw_unit: rawUnit,
      preserved_raw_unit: rawUnit,
      standardized_value: standardizedValue,
      standardized_unit: assertString(raw.standard_units, `$activity[${index}].standard_units`),
      source_id: chemblSourceId,
      source_asset_id: sourceAssetId,
      source_locator: {
        locator_version: "2.0",
        locator_type: "json_pointer",
        asset_id: sourceAssetId,
        logical_file: INPUT_PATH,
        raw_value: rawValueToken,
        json_pointer: `/sources/chembl/activities/${index}`,
      },
    };
  });

  const compoundByIdentity = new Map();
  for (const [index, rawValue] of activitiesInput.entries()) {
    const raw = assertRecord(rawValue, `$input.sources.chembl.activities[${index}]`);
    const row = {
      compound_id: assertString(raw.molecule_chembl_id, `$activity[${index}].molecule_chembl_id`),
      compound_id_namespace: "chembl_compound",
      preferred_name: assertString(raw.molecule_pref_name, `$activity[${index}].molecule_pref_name`),
      canonical_smiles: assertNullableString(raw.canonical_smiles, `$activity[${index}].canonical_smiles`),
      isomeric_smiles: null,
      inchi: null,
      inchi_key: assertNullableString(raw.standard_inchi_key, `$activity[${index}].standard_inchi_key`),
      molecular_formula: assertNullableString(raw.molecular_formula, `$activity[${index}].molecular_formula`),
      molecular_weight: assertFiniteNumber(raw.molecular_weight, `$activity[${index}].molecular_weight`),
      source_id: chemblSourceId,
    };
    const key = `${row.compound_id_namespace}\u0000${row.compound_id}`;
    const previous = compoundByIdentity.get(key);
    assert(
      previous === undefined || stableStringify(previous) === stableStringify(row),
      `conflicting compound facts for ${row.compound_id}`,
    );
    compoundByIdentity.set(key, row);
  }
  for (const [index, rawValue] of pubchemCompounds.entries()) {
    const raw = assertRecord(rawValue, `$input.sources.pubchem.compounds[${index}]`);
    const row = {
      compound_id: String(assertFiniteNumber(raw.cid, `$pubchem[${index}].cid`)),
      compound_id_namespace: "pubchem_cid",
      preferred_name: assertString(raw.iupac_name, `$pubchem[${index}].iupac_name`),
      canonical_smiles: assertNullableString(raw.canonical_smiles, `$pubchem[${index}].canonical_smiles`),
      isomeric_smiles: assertNullableString(raw.isomeric_smiles, `$pubchem[${index}].isomeric_smiles`),
      inchi: assertNullableString(raw.inchi, `$pubchem[${index}].inchi`),
      inchi_key: assertNullableString(raw.inchi_key, `$pubchem[${index}].inchi_key`),
      molecular_formula: assertNullableString(raw.molecular_formula, `$pubchem[${index}].molecular_formula`),
      molecular_weight: assertFiniteNumber(raw.molecular_weight, `$pubchem[${index}].molecular_weight`),
      source_id: pubchemSourceId,
    };
    compoundByIdentity.set(`${row.compound_id_namespace}\u0000${row.compound_id}`, row);
  }
  const compounds = sortedRows([...compoundByIdentity.values()], ["compound_id_namespace", "compound_id"]);

  const assays = sortedRows(
    assaysInput.map((rawValue, index) => {
      const raw = assertRecord(rawValue, `$input.sources.chembl.assays[${index}]`);
      return {
        assay_id: assertString(raw.assay_chembl_id, `$assay[${index}].assay_chembl_id`),
        assay_id_namespace: "chembl_assay",
        assay_type: assayType(assertString(raw.assay_type, `$assay[${index}].assay_type`)),
        description: assertNullableString(raw.description, `$assay[${index}].description`),
        organism: assertNullableString(raw.assay_organism, `$assay[${index}].assay_organism`),
        cell_line: assertNullableString(raw.cell_line, `$assay[${index}].cell_line`),
        target_entity_id: assertString(raw.target_chembl_id, `$assay[${index}].target_chembl_id`),
        target_entity_namespace: "chembl_target",
        bao_format_id: assertNullableString(raw.bao_format, `$assay[${index}].bao_format`),
        source_id: chemblSourceId,
      };
    }),
    ["assay_id_namespace", "assay_id"],
  );

  const targets = sortedRows(
    targetsInput.map((rawValue, index) => {
      const raw = assertRecord(rawValue, `$input.sources.chembl.targets[${index}]`);
      return {
        entity_id: assertString(raw.target_chembl_id, `$target[${index}].target_chembl_id`),
        entity_namespace: "chembl_target",
        entity_type: titleCaseToken(assertString(raw.target_type, `$target[${index}].target_type`)),
        preferred_name: assertString(raw.pref_name, `$target[${index}].pref_name`),
        organism: assertNullableString(raw.organism, `$target[${index}].organism`),
        source_id: chemblSourceId,
      };
    }),
    ["entity_namespace", "entity_id"],
  );

  const compoundCrosswalks = sortedRows(
    crosswalkInput.map((rawValue, index) => {
      const raw = assertRecord(rawValue, `$input.crosswalks[${index}]`);
      return {
        crosswalk_id: assertString(raw.crosswalk_id, `$crosswalk[${index}].crosswalk_id`),
        left_id: assertString(raw.left_id, `$crosswalk[${index}].left_id`),
        left_namespace: assertString(raw.left_namespace, `$crosswalk[${index}].left_namespace`),
        right_id: assertString(raw.right_id, `$crosswalk[${index}].right_id`),
        right_namespace: assertString(raw.right_namespace, `$crosswalk[${index}].right_namespace`),
        relation_type: assertString(raw.relation_type, `$crosswalk[${index}].relation_type`),
        match_method: assertString(raw.match_method, `$crosswalk[${index}].match_method`),
        match_evidence: assertString(raw.match_evidence, `$crosswalk[${index}].match_evidence`),
        conflict_status: assertString(raw.conflict_status, `$crosswalk[${index}].conflict_status`),
        conflict_details: assertNullableString(raw.conflict_details, `$crosswalk[${index}].conflict_details`),
        confidence_score: assertFiniteNumber(raw.confidence_score, `$crosswalk[${index}].confidence_score`),
        confidence_level: assertString(raw.confidence_level, `$crosswalk[${index}].confidence_level`),
        source_id: assertString(raw.source_id, `$crosswalk[${index}].source_id`),
      };
    }),
    ["crosswalk_id"],
  );

  const canonicalAccessions = stableUnique([
    ...activities.map((row) => `chembl_activity:${row.activity_id}`),
    ...compounds.map((row) => `${row.compound_id_namespace}:${row.compound_id}`),
    ...assays.map((row) => `${row.assay_id_namespace}:${row.assay_id}`),
    ...targets.map((row) => `${row.entity_namespace}:${row.entity_id}`),
  ]);
  const datasetIdentityBody = {
    scheme: "bioactivity_dataset_identity.v1",
    source_namespace: sourceNamespace,
    canonical_accessions: canonicalAccessions,
  };
  const datasetId = `ds_${sha256Hex(Buffer.from(stableStringify(datasetIdentityBody), "utf8"))}`;
  const revisionIdentityBody = {
    scheme: "bioactivity_dataset_revision_identity.v1",
    dataset_id: datasetId,
    revision_token: revisionToken,
    provider_snapshot: providerSnapshot,
    carrier_asset_ids: [sourceAssetId],
  };
  const datasetRevisionId = `dsrev_${sha256Hex(
    Buffer.from(stableStringify(revisionIdentityBody), "utf8"),
  )}`;

  return {
    input_sha256: inputSha256,
    source_asset_id: sourceAssetId,
    dataset_id: datasetId,
    dataset_revision_id: datasetRevisionId,
    dataset_identity_body: datasetIdentityBody,
    revision_identity_body: revisionIdentityBody,
    rows: {
      activities,
      compounds,
      assays,
      targets,
      compound_crosswalks: compoundCrosswalks,
    },
  };
}

export function jsonlText(rows, stableStringify) {
  return rows.map((row) => stableStringify(row)).join("\n") + "\n";
}

const EXPECTED_FILE_SET = new Set([
  ".gitattributes",
  "README.md",
  "family-spec.example.json",
  "fixtures/expected/activities.jsonl",
  "fixtures/expected/assays.jsonl",
  "fixtures/expected/compound-crosswalks.jsonl",
  "fixtures/expected/compounds.jsonl",
  "fixtures/expected/targets.jsonl",
  INPUT_PATH,
  "generate-fixtures.mjs",
  "retrieval-metadata.json",
  "validate-fixtures.mjs",
]);
const HEX64 = /^[0-9a-f]{64}$/u;
const ASSET_ID = /^asset_[0-9a-f]{64}$/u;
const DATASET_ID = /^ds_[0-9a-f]{64}$/u;
const DATASET_REVISION_ID = /^dsrev_[0-9a-f]{64}$/u;

async function readJson(relativePath) {
  const text = await readFile(path.join(EXAMPLE_ROOT, relativePath), "utf8");
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON`, { cause: error });
  }
}

async function collectRelativeFiles(directory = EXAMPLE_ROOT) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectRelativeFiles(absolute));
    else files.push(path.relative(EXAMPLE_ROOT, absolute).replaceAll("\\", "/"));
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function assertExactKeys(record, expected, pathLabel) {
  const actual = Object.keys(record).sort((left, right) => left.localeCompare(right, "en"));
  const wanted = [...expected].sort((left, right) => left.localeCompare(right, "en"));
  assert(JSON.stringify(actual) === JSON.stringify(wanted), `${pathLabel} keys must be ${wanted.join(", ")}`);
}

function assertHex64(value, pathLabel) {
  assert(typeof value === "string" && HEX64.test(value), `${pathLabel} must be 64 lowercase hex`);
}

function assertIdentity(value, pattern, pathLabel) {
  assert(typeof value === "string" && pattern.test(value), `${pathLabel} has an invalid identity shape`);
}

function assertNoValueKey(value, pathLabel) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoValueKey(item, `${pathLabel}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    assert(key !== "value", `${pathLabel} must not transport a value payload`);
    assertNoValueKey(item, `${pathLabel}.${key}`);
  }
}

function relationKey(row, fields) {
  return fields.map((field) => JSON.stringify(row[field])).join("\u0000");
}

function validateTopology(parsedFamily, rows) {
  assert(parsedFamily.scope === "example", "FamilySpec.scope must be example");
  assert(parsedFamily.transform_capability_refs.length === 0, "FamilySpec cannot declare a transform capability");
  const projection = parsedFamily.projections[0];
  assert(parsedFamily.projections.length === 1, "FamilySpec must have one reference projection");
  const tableIds = parsedFamily.table_definitions.map((table) => table.table_id);
  assert(
    JSON.stringify(tableIds) === JSON.stringify(Object.keys(EXPECTED_PATHS)),
    "FamilySpec tables must match expected-output tables in declaration order",
  );
  assert(
    JSON.stringify(parsedFamily.declared_outputs.map((output) => output.table_id))
      === JSON.stringify(tableIds),
    "FamilySpec declared outputs must match table definitions",
  );
  assert(
    JSON.stringify([...projection.primary_tables, ...projection.supporting_tables])
      === JSON.stringify(tableIds),
    "Projection table topology must match table definitions",
  );

  for (const table of parsedFamily.table_definitions) {
    const tableRows = rows[table.table_id];
    assert(Array.isArray(tableRows), `missing rows for ${table.table_id}`);
    if (table.required) assert(tableRows.length > 0, `${table.table_id} is required and cannot be empty`);
    const seen = new Set();
    for (const [index, row] of tableRows.entries()) {
      assertExactKeys(row, table.field_names, `${table.table_id}[${index}]`);
      const primaryKey = relationKey(row, table.primary_key);
      assert(!seen.has(primaryKey), `${table.table_id} has duplicate primary key at line ${index + 1}`);
      seen.add(primaryKey);
    }
  }

  for (const relation of parsedFamily.relations) {
    const targets = new Set(
      rows[relation.to_table_id].map((row) => relationKey(row, relation.to_fields)),
    );
    for (const [index, row] of rows[relation.from_table_id].entries()) {
      assert(
        targets.has(relationKey(row, relation.from_fields)),
        `${relation.relation_id} fails at ${relation.from_table_id} line ${index + 1}`,
      );
    }
  }
}

async function validateJsonl(relativePath, expectedRows, stableStringify) {
  const bytes = await readFile(path.join(EXAMPLE_ROOT, relativePath));
  const text = bytes.toString("utf8");
  assert(text.endsWith("\n"), `${relativePath} must end with one newline`);
  assert(!text.endsWith("\n\n"), `${relativePath} cannot contain a blank terminal row`);
  const lines = text.slice(0, -1).split("\n");
  assert(lines.length === expectedRows.length, `${relativePath} row count drift`);
  const parsedRows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let parsed;
    try {
      parsed = JSON.parse(lines[index]);
    } catch (error) {
      throw new Error(`${relativePath}:${lineNumber} is not valid JSON`, { cause: error });
    }
    const canonical = stableStringify(parsed);
    assert(lines[index] === canonical, `${relativePath}:${lineNumber} is not canonical JSON`);
    assert(
      canonical === stableStringify(expectedRows[index]),
      `${relativePath}:${lineNumber} does not equal the row derived from ${INPUT_PATH}`,
    );
    parsedRows.push(parsed);
  }
  return {
    rows: parsedRows,
    row_count: parsedRows.length,
    sha256: sha256Hex(bytes),
  };
}

export async function validateFixtures() {
  const contracts = await loadContracts();
  const requiredApis = [
    "parseFamilySpec",
    "computeFamilySpecDigest",
    "verifyFamilySpecDigest",
    "stableStringify",
  ];
  for (const api of requiredApis) assert(typeof contracts[api] === "function", `missing contracts API ${api}`);

  const files = await collectRelativeFiles();
  assert(
    JSON.stringify(files) === JSON.stringify([...EXPECTED_FILE_SET].sort((left, right) => left.localeCompare(right, "en"))),
    `unexpected example file set: ${files.join(", ")}`,
  );

  const inputBytes = await readFile(path.join(EXAMPLE_ROOT, INPUT_PATH));
  const input = JSON.parse(inputBytes.toString("utf8"));
  const derived = deriveFixture(input, inputBytes, contracts.stableStringify);
  assertIdentity(derived.source_asset_id, ASSET_ID, "derived source_asset_id");
  assertIdentity(derived.dataset_id, DATASET_ID, "derived dataset_id");
  assertIdentity(derived.dataset_revision_id, DATASET_REVISION_ID, "derived dataset_revision_id");

  const familyDocument = await readJson("family-spec.example.json");
  const parsedFamily = contracts.parseFamilySpec(familyDocument.value, "$family_spec");
  const computedFamilyDigest = await contracts.computeFamilySpecDigest(parsedFamily);
  assertHex64(computedFamilyDigest, "computed FamilySpec digest");
  assert(
    computedFamilyDigest === parsedFamily.canonical_digest,
    "FamilySpec canonical_digest does not match computeFamilySpecDigest",
  );
  assert(
    await contracts.verifyFamilySpecDigest(parsedFamily),
    "verifyFamilySpecDigest rejected the checked-in FamilySpec",
  );

  const committedRows = {};
  const outputFacts = {};
  for (const [table, relativePath] of Object.entries(EXPECTED_PATHS)) {
    const result = await validateJsonl(relativePath, derived.rows[table], contracts.stableStringify);
    committedRows[table] = result.rows;
    outputFacts[table] = {
      path: relativePath,
      row_count: result.row_count,
      sha256: result.sha256,
    };
  }
  validateTopology(parsedFamily, committedRows);

  for (const [index, activity] of committedRows.activities.entries()) {
    assert(activity.raw_relation === activity.preserved_relation, `activities line ${index + 1} relation drift`);
    assert(activity.raw_unit === activity.preserved_raw_unit, `activities line ${index + 1} unit drift`);
    assert(activity.source_asset_id === derived.source_asset_id, `activities line ${index + 1} asset drift`);
    assert(activity.source_locator.asset_id === derived.source_asset_id, `activities line ${index + 1} locator asset drift`);
    assert(activity.source_locator.logical_file === INPUT_PATH, `activities line ${index + 1} locator file drift`);
  }

  const metadataDocument = await readJson("retrieval-metadata.json");
  const metadata = assertRecord(metadataDocument.value, "$metadata");
  assertExactKeys(metadata, [
    "schema_version",
    "example_id",
    "family_id",
    "retrieval_only",
    "host_availability",
    "catalog",
    "claims",
    "contracts_api_dependencies",
    "identity",
    "expected_outputs",
    "retrieval_tags",
  ], "$metadata");
  assert(metadata.schema_version === "1.0", "metadata schema_version must be 1.0");
  assert(metadata.example_id === "bioactivity-measurement", "metadata example_id drift");
  assert(metadata.family_id === "bioactivity_measurement", "metadata family_id drift");
  assert(metadata.retrieval_only === true, "metadata must be retrieval_only");
  assert(metadata.host_availability === "unavailable", "Host must remain unavailable");

  const catalog = assertRecord(metadata.catalog, "$metadata.catalog");
  assertExactKeys(catalog, ["kind", "scope", "id", "version", "digest", "status", "executable"], "$metadata.catalog");
  assertNoValueKey(catalog, "$metadata.catalog");
  assert(catalog.kind === "family_spec", "catalog kind must be family_spec");
  assert(catalog.scope === "example", "catalog scope must be example");
  assert(catalog.id === parsedFamily.family_spec_id, "catalog id must bind the FamilySpec");
  assert(catalog.version === parsedFamily.semantic_version, "catalog version must bind the FamilySpec");
  assert(catalog.digest === computedFamilyDigest, "catalog digest must bind the FamilySpec");
  assert(catalog.status === "submitted", "catalog status must be submitted");
  assert(catalog.executable === false, "catalog executable must be false");

  const claims = assertRecord(metadata.claims, "$metadata.claims");
  assertExactKeys(claims, [
    "dataset_transform",
    "compiler_or_bundle",
    "implementation_identity",
    "host_receipt",
    "core_admission",
    "host_fixture",
    "shadow",
    "e3",
    "publication",
  ], "$metadata.claims");
  for (const [name, value] of Object.entries(claims)) assert(value === false, `claim ${name} must be false`);

  assert(
    JSON.stringify(metadata.contracts_api_dependencies) === JSON.stringify(requiredApis),
    "metadata contracts API dependency list drift",
  );
  assert(
    !metadataDocument.text.includes("packages/contracts/src")
      && !metadataDocument.text.includes("contracts_source")
      && !metadataDocument.text.includes("contracts_shape_sha256"),
    "metadata cannot record a contracts source-file hash",
  );

  const identity = assertRecord(metadata.identity, "$metadata.identity");
  assertExactKeys(identity, [
    "input_path",
    "input_sha256",
    "source_asset_id",
    "dataset_id",
    "dataset_revision_id",
    "canonical_rules",
  ], "$metadata.identity");
  assert(identity.input_path === INPUT_PATH, "identity input path drift");
  assertHex64(identity.input_sha256, "identity.input_sha256");
  assert(identity.input_sha256 === derived.input_sha256, "input byte digest drift");
  assert(identity.source_asset_id === derived.source_asset_id, "source asset identity drift");
  assert(identity.dataset_id === derived.dataset_id, "dataset identity drift");
  assert(identity.dataset_revision_id === derived.dataset_revision_id, "dataset revision identity drift");
  const canonicalRules = assertRecord(identity.canonical_rules, "$metadata.identity.canonical_rules");
  assert(canonicalRules.build_id_participates === false, "buildId must not participate in identity");
  assert(
    canonicalRules.dataset_identity_body === contracts.stableStringify(derived.dataset_identity_body),
    "dataset canonical body drift",
  );
  assert(
    canonicalRules.revision_identity_body === contracts.stableStringify(derived.revision_identity_body),
    "revision canonical body drift",
  );

  assert(
    contracts.stableStringify(metadata.expected_outputs) === contracts.stableStringify(outputFacts),
    "expected output metadata drift",
  );

  console.log(
    `validate-fixtures.mjs: valid FamilySpec ${computedFamilyDigest}; `
      + `${Object.values(outputFacts).reduce((total, item) => total + item.row_count, 0)} JSONL rows verified`,
  );
  return { family_digest: computedFamilyDigest, derived, output_facts: outputFacts };
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await validateFixtures();
}
