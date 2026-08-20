#!/usr/bin/env node
import { buildGoldDiagnosticMatrix, goldDiagnosticExitCode, serializeGoldDiagnosticMatrix, writeGoldDiagnosticMatrixAtomic } from "./gold-diagnostic-matrix.js";

interface CliOptions {
  evidenceRoot: string;
  goldRoot: string;
  targetProductCommit: string;
  outputPath: string | null;
}

function usage(): string {
  return "Usage: node --import tsx server/src/evaluation/gold-diagnostic-matrix-cli.ts --evidence-root DIR --gold-root DIR --target-commit HEX [--output FILE]";
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
  return value;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let evidenceRoot: string | null = null;
  let goldRoot: string | null = null;
  let targetProductCommit: string | null = null;
  let outputPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exitCode = 0;
      throw new Error("__help__");
    }
    if (option === "--evidence-root") evidenceRoot = requiredValue(argv, ++index, option);
    else if (option === "--gold-root") goldRoot = requiredValue(argv, ++index, option);
    else if (option === "--target-commit") targetProductCommit = requiredValue(argv, ++index, option);
    else if (option === "--output") outputPath = requiredValue(argv, ++index, option);
    else throw new TypeError(`Unknown option ${option}\n${usage()}`);
  }
  if (evidenceRoot === null || goldRoot === null || targetProductCommit === null) {
    throw new TypeError(`--evidence-root, --gold-root, and --target-commit are required\n${usage()}`);
  }
  return { evidenceRoot, goldRoot, targetProductCommit, outputPath };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const matrix = await buildGoldDiagnosticMatrix({
    evidence_root: options.evidenceRoot,
    gold_root: options.goldRoot,
    target_product_commit: options.targetProductCommit,
  });
  const serialized = serializeGoldDiagnosticMatrix(matrix);
  if (options.outputPath === null) process.stdout.write(serialized);
  else {
    await writeGoldDiagnosticMatrixAtomic(options.outputPath, serialized);
    process.stdout.write(serialized);
  }
  process.exitCode = goldDiagnosticExitCode(matrix);
} catch (error) {
  if (error instanceof Error && error.message === "__help__") process.exitCode = 0;
  else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 4;
  }
}
