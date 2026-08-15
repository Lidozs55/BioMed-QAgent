import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ArtifactDownloadButton } from "@/components/artifacts/ArtifactDownloadButton";
import { CsvPreview } from "@/components/artifacts/CsvPreview";
import { isCsvPreviewable } from "@/components/artifacts/artifactPreview";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAPI } from "@/hooks/useAPI";
import { fileType, formatSize } from "@/lib/fileUtils";
import type { ArtifactProjection } from "@/runtime/types";

/** Legacy artifact-store card (task-level artifacts from run_manifest events). */
export function ArtifactCard({
  artifact,
  taskId,
  noDataMessage,
}: {
  artifact: ArtifactProjection;
  taskId: string;
  noDataMessage?: string;
}) {
  const { getArtifactUrl } = useAPI();
  const { Icon, label } = fileType(artifact.name, artifact.role);
  const url = getArtifactUrl(taskId, artifact.artifact_id);
  const previewable = isCsvPreviewable(artifact.name);

  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <div className="flex min-w-0 items-center gap-2">
          <Icon aria-hidden="true" className="shrink-0 text-muted-foreground" />
          <CardTitle className="min-w-0 truncate" title={artifact.name}>
            {artifact.name}
          </CardTitle>
          <Badge variant="outline" className="shrink-0">{label}</Badge>
        </div>
        <CardDescription>{formatSize(artifact.size)}</CardDescription>
      </CardHeader>
      {previewable && (
        <CardContent>
          <Accordion>
            <AccordionItem value={`csv-preview-${artifact.artifact_id}`}>
              <AccordionTrigger>CSV 预览</AccordionTrigger>
              <AccordionContent><CsvPreview artifactUrl={url} noDataMessage={noDataMessage} /></AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      )}
      <CardFooter>
        <ArtifactDownloadButton url={url} filename={artifact.name} />
      </CardFooter>
    </Card>
  );
}