import { ArtifactDownloadButton } from "@/components/artifacts/ArtifactDownloadButton";
import { CsvPreview } from "@/components/artifacts/CsvPreview";
import { artifactBasename, isCsvPreviewable } from "@/components/artifacts/artifactPreview";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAPI } from "@/hooks/useAPI";
import { formatSize } from "@/lib/fileUtils";
import type { ManifestArtifactEntry } from "@/runtime/contracts";

/** V2 manifest-driven build artifact card. */
export function BuildArtifactCard({
  entry,
  buildId,
  taskId,
  previewCsv,
}: {
  entry: ManifestArtifactEntry;
  buildId: string;
  taskId?: string | null;
  previewCsv?: boolean;
}) {
  const { getBuildArtifactUrl } = useAPI();
  const name = artifactBasename(entry);
  const url = getBuildArtifactUrl(buildId, entry.artifact_id, taskId);
  const previewable = previewCsv === true && isCsvPreviewable(name);
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle className="truncate text-sm" title={name}>{name}</CardTitle>
        <CardDescription>
          {entry.media_type} · {formatSize(entry.size_bytes)}
        </CardDescription>
      </CardHeader>
      {previewable && (
        <CardContent>
          <CsvPreview artifactUrl={url} noDataMessage="无数据" />
        </CardContent>
      )}
      <CardFooter>
        <ArtifactDownloadButton url={url} filename={name} />
      </CardFooter>
    </Card>
  );
}