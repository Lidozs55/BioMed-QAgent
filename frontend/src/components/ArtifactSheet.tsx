import PublicationResultsViewer from "@/components/PublicationResultsViewer";
import {
  ArtifactPanel,
  ArtifactSaveAllButton,
} from "@/components/ArtifactPanel";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { ArtifactProjection } from "@/runtime/types";

type DownloadArtifact = (url: string, filename: string) => void;

interface ArtifactSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifacts: readonly ArtifactProjection[];
  taskId: string;
  /** V2 build id — shows the manifest-driven build view instead of legacy files. */
  publicationId?: string | null;
  download?: DownloadArtifact;
}

export function ArtifactSheet({
  open,
  onOpenChange,
  artifacts,
  taskId,
  publicationId = null,
  download,
}: ArtifactSheetProps) {
  const legacyView = publicationId === null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh]">
        <SheetHeader>
          <SheetTitle>任务产物</SheetTitle>
          <SheetDescription>
            {publicationId !== null
              ? "V2 数据构建结果"
              : `${artifacts.length} 个已验证文件`}
          </SheetDescription>
        </SheetHeader>
        {legacyView ? (
          <ArtifactPanel
            artifacts={artifacts}
            taskId={taskId}
            download={download}
          />
        ) : (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-4">
            <PublicationResultsViewer
              publicationId={publicationId}
              taskId={taskId}
            />
          </div>
        )}
        {legacyView && (
          <ArtifactSaveAllButton
            artifacts={artifacts}
            taskId={taskId}
            download={download}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
