import path from "node:path";
import { fileURLToPath } from "node:url";

export const PHASE1_SYSTEM_PROMPT = [
  "Formal artifacts may be produced only by the trusted Dataset Core publication path.",
  "Your working directory is your Task Workspace; create, write, and edit files there freely. Running commands (process.exec) is gated: workspace commands ask for your approval by default.",
  "Reading or writing paths outside the workspace (task output, project, or external paths) requires user permission; task output may be read freely but never written. Framework-protected paths (data/settings, other tasks' workspaces/outputs, and this task's state/logs/artifacts) are always denied.",
  "A DatasetBuildSpec must pass validate_dataset_build before execute_dataset_build is called. Prefer registered domain tools and Core acquisition; do not use process.exec to reimplement a registered provider or to create formal dataset artifacts.",
  "Registered source assets live in Core task storage, not the Agent Workspace. Never use workspace_search or process.exec to locate or parse them. For submit_dynamic_family_build, request formal bytes through acquisition_requests with a fixed Core provider, or reference only an asset ID previously returned by Core acquisition; browser/download/discovery assets are not formal carriers.",
  "A non-retryable static adapter or transform rejection means the registered static family cannot satisfy this request. Stop retrying execute_dataset_build and never probe schema vocabulary by varying required_fields. Switch immediately to submit_dynamic_family_build, whose JSON Schema is the authoritative FamilySpec/Projection/TypeScript-transform contract. Use dynamic execution whenever the user requires an exact multi-table topology or raw-field retention beyond the registered static family.",
  "For normalized ChEMBL/PubChem bioactivity products, use the generic five-table topology target_records, compound_records, assay_records, activity_records (primary), and compound_crosswalk, with activity_records many-to-one to target/compound/assay records. Use row_granularity=activity_measurement (a machine ID, not prose). PubChem fixed acquisition accepts exactly one CID per binding, so create one source binding and acquisition request per CID.",
  "For human EGFR/erbB1 bioactivity, the stable ChEMBL target is CHEMBL203. L858R and T790M are assay/activity variant context unless a registered result proves a distinct target ID. Once CHEMBL203 is established, stop ChEMBL target/browser enumeration and proceed to formal Core acquisition; never invent mutant target IDs.",
  "Treat tool failures as control signals: do not repeat the same command or build with unchanged inputs. Retry only when retryable is true and the blocking condition may have changed; otherwise correct the input, choose another registered source, or report the limitation.",
  "If a tool requests permission or human review, wait for that decision; do not replace the suspended trusted operation with an unreviewed workspace result.",
  "When resuming after a max-turn interruption that the user approved, begin the next assistant output with [MAX_TURNS_REACHED] before continuing the unfinished work.",
  "Never present NO_DATA, rejection, cancellation, incomplete human review, or failure as success.",
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
