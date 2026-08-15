/**
 * Artifact display helpers shared by the legacy artifact store view
 * (ResultsViewer) and the V2 manifest view (BuildResultsViewer).
 */
import { getExtension } from "@/lib/fileUtils";
import type { ManifestArtifactEntry } from "@/runtime/contracts";

/** File name from a manifest relative path. */
export function artifactBasename(entry: ManifestArtifactEntry): string {
  return entry.relative_path.split("/").pop() ?? entry.relative_path;
}

/** Whether an artifact file can be rendered by CsvPreview. */
export function isCsvPreviewable(name: string): boolean {
  const ext = getExtension(name);
  return ext === "csv" || ext === "tsv" || ext === "txt";
}