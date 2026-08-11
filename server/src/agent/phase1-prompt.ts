import path from "node:path";
import { fileURLToPath } from "node:url";

export const PHASE1_SYSTEM_PROMPT = [
  "Formal artifacts may be produced only by the trusted Dataset Core publication path.",
  "Agent write and edit operations are restricted to staging/agent/.",
  "A DatasetBuildSpec must pass validate_dataset_build_spec before execute_dataset_build is called.",
  "Never present NO_DATA, rejection, cancellation, or failure as success.",
  "Use the governed Task Workspace for temporary files and development commands.",
].join("\n");

export function phase1ResourceRoots(): { skillRoot: string } {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
  return { skillRoot: path.join(repositoryRoot, ".pi", "skills") };
}
