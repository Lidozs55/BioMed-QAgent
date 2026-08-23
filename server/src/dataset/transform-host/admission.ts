import { types } from "node:util";

import {
  computeImplementationDigest,
  parseDatasetTransform,
  type DatasetTransform,
} from "@biomed/contracts";
import ts from "typescript";

import { TransformHostError } from "./errors.js";
import { sha256Bytes } from "./hashing.js";

export const TRANSFORM_HOST_PROTOCOL_VERSION = "1.0" as const;
export const TRANSFORM_HOST_POLICY_VERSION = "fixture-only.1" as const;
export const TRANSFORM_RUNTIME_ABI_VERSION = "unavailable.1" as const;
export const UNISOLATED_TRANSFORM_POLICY_VERSION = "in-process-unisolated.1" as const;
export const UNISOLATED_TRANSFORM_RUNTIME_ABI_VERSION = "in-process-unisolated.1" as const;
export const TRANSFORM_SDK_MODULE = "@biomed/transform-sdk/v1" as const;
export const TRANSFORM_HOST_FIXTURE_PROFILE_ID = "fixture-ts-v1" as const;

const MAX_SOURCE_BYTES = 256 * 1024;
const SUBMISSION_KEYS = new Set(["source"]);
const DESCRIPTOR_METADATA_KEYS = new Set([
  "transform_id",
  "version",
  "entrypoint",
  "declared_input_roles",
  "declared_output_tables",
  "bound_family_spec_digest",
  "bound_projection_digest",
  "determinism_profile",
  "resource_class",
  "origin",
  "scope",
  "review_refs",
]);
const COMPILER_ID = "typescript.transpileModule";
const COMPILED_BUNDLE_BYTES = new WeakMap<object, Uint8Array>();

const FORBIDDEN_IDENTIFIERS = Object.freeze([
  "Bun",
  "Deno",
  "Function",
  "Proxy",
  "Reflect",
  "WebAssembly",
  "XMLHttpRequest",
  "WebSocket",
  "__proto__",
  "constructor",
  "eval",
  "fetch",
  "global",
  "globalThis",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "getPrototypeOf",
  "module",
  "ownKeys",
  "process",
  "prototype",
  "require",
  "setPrototypeOf",
]);
const FORBIDDEN_IDENTIFIER_SET = new Set(FORBIDDEN_IDENTIFIERS);

const COMPILER_OPTIONS = Object.freeze({
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  isolatedModules: true,
  sourceMap: false,
  inlineSourceMap: false,
  inlineSources: false,
  removeComments: false,
} satisfies ts.CompilerOptions);

interface ServerOwnedAdmissionProfile {
  readonly id: typeof TRANSFORM_HOST_FIXTURE_PROFILE_ID;
  readonly allowedModules: readonly typeof TRANSFORM_SDK_MODULE[];
  readonly dependencyClosure: readonly Readonly<{
    module: typeof TRANSFORM_SDK_MODULE;
    version: "host-fixture-stub-v1";
  }>[];
}

const FIXTURE_PROFILE: ServerOwnedAdmissionProfile = Object.freeze({
  id: TRANSFORM_HOST_FIXTURE_PROFILE_ID,
  allowedModules: Object.freeze([TRANSFORM_SDK_MODULE]),
  dependencyClosure: Object.freeze([
    Object.freeze({ module: TRANSFORM_SDK_MODULE, version: "host-fixture-stub-v1" }),
  ]),
});

export interface TransformAdmissionSubmission {
  source: string;
}

export type FixtureTransformDescriptorMetadata = Pick<
  DatasetTransform,
  | "transform_id"
  | "version"
  | "entrypoint"
  | "declared_input_roles"
  | "declared_output_tables"
  | "bound_family_spec_digest"
  | "bound_projection_digest"
  | "determinism_profile"
  | "resource_class"
  | "origin"
  | "scope"
  | "review_refs"
>;

/**
 * A transpile-only artifact. It is intentionally not an admitted bundle receipt:
 * transpileModule does not perform whole-program type checking, dependency
 * resolution, or linking, and a source denylist is not a runtime sandbox.
 */
export interface FixtureOnlyCompilationResult {
  status: "fixture_only_unexecutable";
  executable: false;
  trustBearingAdmission: false;
  profileId: typeof TRANSFORM_HOST_FIXTURE_PROFILE_ID;
  normalizedSource: string;
  sourceDigest: string;
  importedModules: readonly string[];
  emittedBundleSizeBytes: number;
  bundleDigest: string;
  codeBundleRef: `bundle_${string}`;
  compilerId: typeof COMPILER_ID;
  compilerVersion: string;
  compilerOptionsDigest: string;
  compilerDigest: string;
  dependencyClosureDigest: string;
  runtimeAbiVersion: typeof TRANSFORM_RUNTIME_ABI_VERSION;
  policyVersion: typeof TRANSFORM_HOST_POLICY_VERSION;
  policyDigest: string;
  implementationDigest: string;
}

/**
 * Host-compiled bundle admitted only for the explicitly opted-in in-process
 * backend. Static admission narrows the API surface but is not isolation and
 * establishes no security boundary.
 */
export interface InProcessUnisolatedCompilationResult
  extends Omit<
    FixtureOnlyCompilationResult,
    "status" | "executable" | "runtimeAbiVersion" | "policyVersion"
  > {
  status: "admitted_in_process_unisolated";
  executable: true;
  runtimeAbiVersion: typeof UNISOLATED_TRANSFORM_RUNTIME_ABI_VERSION;
  policyVersion: typeof UNISOLATED_TRANSFORM_POLICY_VERSION;
}

export type HostCompilationResult =
  | FixtureOnlyCompilationResult
  | InProcessUnisolatedCompilationResult;

/** Frozen normalization used before all Host-owned compilation and hashing. */
export function normalizeTransformSource(source: string): string {
  if (source.includes("\0")) {
    throw new TransformHostError("source_invalid", "Transform source contains a NUL byte");
  }
  const withoutBom = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const normalized = `${withoutBom.replace(/\r\n?/g, "\n").normalize("NFC").replace(/\n*$/, "")}\n`;
  if (Buffer.byteLength(normalized, "utf8") > MAX_SOURCE_BYTES) {
    throw new TransformHostError(
      "source_invalid",
      `Transform source exceeds the ${MAX_SOURCE_BYTES}-byte fixture limit`,
    );
  }
  return normalized;
}

/**
 * Resolve policy, inspect source, transpile, and hash the complete closure in one
 * Host-owned step. Runtime exact-object parsing prevents a caller from injecting
 * emitted bytes, compiler/dependency digests, or an expanded module allowlist.
 */
export async function compileTransformFixtureOnly(value: unknown): Promise<FixtureOnlyCompilationResult> {
  const submission = parseSubmission(value);
  const profile = resolveServerOwnedProfile();
  const normalizedSource = normalizeTransformSource(submission.source);
  const importedModules = inspectSource(normalizedSource, profile);
  const transpiled = ts.transpileModule(normalizedSource, {
    fileName: "transform.ts",
    reportDiagnostics: true,
    compilerOptions: COMPILER_OPTIONS,
  });
  const syntaxError = (transpiled.diagnostics ?? []).find(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (syntaxError) {
    throw new TransformHostError(
      "source_invalid",
      `Transform source is not valid isolated TypeScript: ${ts.flattenDiagnosticMessageText(syntaxError.messageText, "\n")}`,
    );
  }

  const emittedBundleBytes = new TextEncoder().encode(transpiled.outputText);
  const sourceDigest = sha256Bytes(normalizedSource);
  const bundleDigest = sha256Bytes(emittedBundleBytes);
  const compilerOptionsDigest = sha256Bytes(canonicalJson({
    inlineSourceMap: false,
    inlineSources: false,
    isolatedModules: true,
    module: "ESNext",
    removeComments: false,
    sourceMap: false,
    target: "ES2022",
  }));
  const dependencyClosureDigest = sha256Bytes(canonicalJson(profile.dependencyClosure));
  const compilerDigest = sha256Bytes(canonicalJson({
    compilerId: COMPILER_ID,
    compilerOptionsDigest,
    compilerVersion: ts.version,
    dependencyClosureDigest,
  }));
  const policyDigest = sha256Bytes(canonicalJson({
    allowedModules: profile.allowedModules,
    forbiddenIdentifiers: FORBIDDEN_IDENTIFIERS,
    maxSourceBytes: MAX_SOURCE_BYTES,
    policyVersion: TRANSFORM_HOST_POLICY_VERSION,
    profileId: profile.id,
    runtimeAbiVersion: TRANSFORM_RUNTIME_ABI_VERSION,
    staticChecksAreSandbox: false,
  }));
  const implementationDigest = await computeImplementationDigest({
    normalized_source_sha256: sourceDigest,
    emitted_bundle_sha256: bundleDigest,
    compiler_id: COMPILER_ID,
    compiler_version: ts.version,
    compiler_options_digest: compilerOptionsDigest,
    dependency_closure_digest: dependencyClosureDigest,
    runtime_abi_version: TRANSFORM_RUNTIME_ABI_VERSION,
    host_policy_version: policyDigest,
  });

  const result: FixtureOnlyCompilationResult = Object.freeze({
    status: "fixture_only_unexecutable",
    executable: false,
    trustBearingAdmission: false,
    profileId: profile.id,
    normalizedSource,
    sourceDigest,
    importedModules,
    emittedBundleSizeBytes: emittedBundleBytes.byteLength,
    bundleDigest,
    codeBundleRef: `bundle_${bundleDigest}`,
    compilerId: COMPILER_ID,
    compilerVersion: ts.version,
    compilerOptionsDigest,
    compilerDigest,
    dependencyClosureDigest,
    runtimeAbiVersion: TRANSFORM_RUNTIME_ABI_VERSION,
    policyVersion: TRANSFORM_HOST_POLICY_VERSION,
    policyDigest,
    implementationDigest,
  });
  COMPILED_BUNDLE_BYTES.set(result, Uint8Array.from(emittedBundleBytes));
  return result;
}

/**
 * Compile the same statically admitted source to a CommonJS bundle consumed by
 * the synchronous in-process backend. This is an explicit non-isolated mode;
 * neither compilation nor the runtime backend is a security boundary.
 */
export async function compileTransformInProcessUnisolated(
  value: unknown,
): Promise<InProcessUnisolatedCompilationResult> {
  const fixture = await compileTransformFixtureOnly(value);
  const profile = resolveServerOwnedProfile();
  const compilerOptions = {
    ...COMPILER_OPTIONS,
    module: ts.ModuleKind.CommonJS,
  } satisfies ts.CompilerOptions;
  const transpiled = ts.transpileModule(fixture.normalizedSource, {
    fileName: "transform.ts",
    reportDiagnostics: true,
    compilerOptions,
  });
  const syntaxError = (transpiled.diagnostics ?? []).find(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (syntaxError) {
    throw new TransformHostError(
      "source_invalid",
      `Transform source is not valid isolated TypeScript: ${ts.flattenDiagnosticMessageText(syntaxError.messageText, "\n")}`,
    );
  }

  const emittedBundleBytes = new TextEncoder().encode(transpiled.outputText);
  const bundleDigest = sha256Bytes(emittedBundleBytes);
  const compilerOptionsDigest = sha256Bytes(canonicalJson({
    inlineSourceMap: false,
    inlineSources: false,
    isolatedModules: true,
    module: "CommonJS",
    removeComments: false,
    sourceMap: false,
    target: "ES2022",
  }));
  const compilerDigest = sha256Bytes(canonicalJson({
    compilerId: COMPILER_ID,
    compilerOptionsDigest,
    compilerVersion: ts.version,
    dependencyClosureDigest: fixture.dependencyClosureDigest,
  }));
  const policyDigest = sha256Bytes(canonicalJson({
    allowedModules: profile.allowedModules,
    forbiddenIdentifiers: FORBIDDEN_IDENTIFIERS,
    maxSourceBytes: MAX_SOURCE_BYTES,
    policyVersion: UNISOLATED_TRANSFORM_POLICY_VERSION,
    profileId: profile.id,
    runtimeAbiVersion: UNISOLATED_TRANSFORM_RUNTIME_ABI_VERSION,
    securityBoundary: false,
    staticChecksAreSandbox: false,
  }));
  const implementationDigest = await computeImplementationDigest({
    normalized_source_sha256: fixture.sourceDigest,
    emitted_bundle_sha256: bundleDigest,
    compiler_id: COMPILER_ID,
    compiler_version: ts.version,
    compiler_options_digest: compilerOptionsDigest,
    dependency_closure_digest: fixture.dependencyClosureDigest,
    runtime_abi_version: UNISOLATED_TRANSFORM_RUNTIME_ABI_VERSION,
    host_policy_version: policyDigest,
  });
  const result: InProcessUnisolatedCompilationResult = Object.freeze({
    status: "admitted_in_process_unisolated",
    executable: true,
    trustBearingAdmission: false,
    profileId: fixture.profileId,
    normalizedSource: fixture.normalizedSource,
    sourceDigest: fixture.sourceDigest,
    importedModules: fixture.importedModules,
    emittedBundleSizeBytes: emittedBundleBytes.byteLength,
    bundleDigest,
    codeBundleRef: `bundle_${bundleDigest}`,
    compilerId: COMPILER_ID,
    compilerVersion: ts.version,
    compilerOptionsDigest,
    compilerDigest,
    dependencyClosureDigest: fixture.dependencyClosureDigest,
    runtimeAbiVersion: UNISOLATED_TRANSFORM_RUNTIME_ABI_VERSION,
    policyVersion: UNISOLATED_TRANSFORM_POLICY_VERSION,
    policyDigest,
    implementationDigest,
  });
  COMPILED_BUNDLE_BYTES.set(result, Uint8Array.from(emittedBundleBytes));
  return result;
}

/**
 * Combine caller metadata with the exact Host-produced digest closure. Runtime
 * exact parsing rejects attempts to smuggle compiler, dependency, policy, or
 * bundle facts through the metadata object.
 */
export function createFixtureDatasetTransform(
  value: unknown,
  result: FixtureOnlyCompilationResult,
): DatasetTransform {
  return createDatasetTransformFromCompilation(value, result, "$.fixture_transform");
}

/**
 * Construct the descriptor for the explicit in-process backend from the exact
 * Host-owned compilation result. This is not an isolation or trust boundary.
 */
export function createInProcessDatasetTransform(
  value: unknown,
  result: InProcessUnisolatedCompilationResult,
): DatasetTransform {
  return createDatasetTransformFromCompilation(value, result, "$.in_process_transform");
}

function createDatasetTransformFromCompilation(
  value: unknown,
  result: HostCompilationResult,
  path: string,
): DatasetTransform {
  hostCompiledBytes(result);
  const metadata = parseDescriptorMetadata(value);
  return parseDatasetTransform({
    ...metadata,
    source_digest: result.sourceDigest,
    bundle_digest: result.bundleDigest,
    compiler_id: result.compilerId,
    compiler_version: result.compilerVersion,
    compiler_options_digest: result.compilerOptionsDigest,
    runtime_abi_version: result.runtimeAbiVersion,
    runtime_policy_version: result.policyVersion,
    dependency_closure_digest: result.dependencyClosureDigest,
    code_bundle_ref: result.codeBundleRef,
  }, path);
}

/** Internal Host hand-off: rejects structurally forged fixture results. */
export function copyHostCompiledFixtureBytes(result: HostCompilationResult): Uint8Array {
  const bytes = hostCompiledBytes(result);
  return Uint8Array.from(bytes);
}

function hostCompiledBytes(result: HostCompilationResult): Uint8Array {
  const bytes = COMPILED_BUNDLE_BYTES.get(result);
  if (!bytes) {
    throw new TransformHostError(
      "descriptor_mismatch",
      "Fixture result was not produced by this Host admission instance",
    );
  }
  return bytes;
}

function parseSubmission(value: unknown): TransformAdmissionSubmission {
  const record = exactOwnDataRecord(value, "Transform admission submission", SUBMISSION_KEYS, "source_invalid");
  if (typeof record.source !== "string") {
    throw new TransformHostError("source_invalid", "Transform admission source must be a string");
  }
  return { source: record.source };
}

function parseDescriptorMetadata(value: unknown): FixtureTransformDescriptorMetadata {
  return exactOwnDataRecord(
    value,
    "Transform descriptor metadata",
    DESCRIPTOR_METADATA_KEYS,
    "descriptor_mismatch",
  ) as FixtureTransformDescriptorMetadata;
}

function exactOwnDataRecord(
  value: unknown,
  label: string,
  allowed: ReadonlySet<string>,
  code: "source_invalid" | "descriptor_mismatch",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) {
    throw new TransformHostError(code, `${label} must be a plain non-Proxy object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TransformHostError(code, `${label} must have a plain object prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new TransformHostError(code, `${label} must not contain symbol fields`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TransformHostError(code, `${label}.${key} must be an enumerable data property`);
    }
    if (!allowed.has(key)) {
      throw new TransformHostError(code, `${label} has unknown fields: ${key}`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function resolveServerOwnedProfile(): ServerOwnedAdmissionProfile {
  return FIXTURE_PROFILE;
}

function inspectSource(
  normalizedSource: string,
  profile: ServerOwnedAdmissionProfile,
): readonly string[] {
  const file = ts.createSourceFile(
    "transform.ts",
    normalizedSource,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const importedModules = new Set<string>();
  const allowedModules = new Set<string>(profile.allowedModules);
  const reject = (message: string): never => {
    throw new TransformHostError("source_policy_violation", message);
  };
  const inspect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteralLike(specifier)) {
        if (!allowedModules.has(specifier.text)) {
          reject(`Module "${specifier.text}" is not in the server-owned Transform SDK allowlist`);
        }
        importedModules.add(specifier.text);
      } else {
        reject("Transform imports and re-exports must use a static string module specifier");
      }
    }
    if (ts.isImportEqualsDeclaration(node)) {
      reject("TypeScript import-equals declarations are forbidden in DatasetTransform source");
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      reject("Dynamic module loading is forbidden in DatasetTransform source");
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      reject("Module metadata access is forbidden in DatasetTransform source");
    }
    if (ts.isElementAccessExpression(node)) {
      reject("Computed property access is forbidden in fixture source because it can hide prototype escapes");
    }
    if (ts.isComputedPropertyName(node)) {
      reject("Computed property names are forbidden in fixture source");
    }
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIER_SET.has(node.text)) {
      reject(`Identifier "${node.text}" is forbidden in DatasetTransform source`);
    }
    if (
      (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && FORBIDDEN_IDENTIFIER_SET.has(node.text)
    ) {
      reject(`Property escape token "${node.text}" is forbidden in DatasetTransform source`);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(file);
  return Object.freeze([...importedModules].sort());
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}
