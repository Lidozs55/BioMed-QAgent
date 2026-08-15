import path from "node:path";
import { fileURLToPath } from "node:url";

export const PHASE1_SYSTEM_PROMPT = [
  "Formal artifacts may be produced only by the trusted Dataset Core publication path.",
  "Your working directory is your Task Workspace; create, write, edit and run commands there freely.",
  "Reading or writing files outside the workspace (task output, project, or external paths) requires user permission.",
  "A DatasetBuildSpec must pass validate_dataset_build before execute_dataset_build is called.",
  "Never present NO_DATA, rejection, cancellation, or failure as success.",
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
