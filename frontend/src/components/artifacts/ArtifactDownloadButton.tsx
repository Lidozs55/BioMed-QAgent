import { DownloadIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { triggerArtifactDownload } from "@/lib/fileUtils";

/** Shared artifact download button (legacy + V2 build artifacts). */
export function ArtifactDownloadButton({
  url,
  filename,
}: {
  url: string;
  filename: string;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => triggerArtifactDownload(url, filename)}
    >
      <DownloadIcon data-icon="inline-start" />
      下载
    </Button>
  );
}