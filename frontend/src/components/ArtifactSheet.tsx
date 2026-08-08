import { useState } from "react";
import { DownloadIcon } from "@phosphor-icons/react";

import ResultsViewer from "@/components/ResultsViewer";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useAPI } from "@/hooks/useAPI";
import {
  fileType,
  formatSize,
  triggerArtifactDownload,
} from "@/lib/fileUtils";
import type { ArtifactProjection } from "@/runtime/types";

type DownloadArtifact = (url: string, filename: string) => void;

interface ArtifactSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifacts: readonly ArtifactProjection[];
  taskId: string;
  download?: DownloadArtifact;
}

export function ArtifactSheet({
  open,
  onOpenChange,
  artifacts,
  taskId,
  download = triggerArtifactDownload,
}: ArtifactSheetProps) {
  const { getArtifactUrl } = useAPI();
  const [tab, setTab] = useState("list");
  const [selectedArtifactId, setSelectedArtifactId] = useState(
    artifacts[0]?.artifact_id ?? null,
  );

  const selectedArtifact =
    artifacts.find(
      (artifact) => artifact.artifact_id === selectedArtifactId,
    ) ?? artifacts[0];

  const downloadArtifact = (artifact: ArtifactProjection) => {
    download(
      getArtifactUrl(taskId, artifact.artifact_id),
      artifact.name,
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh]">
        <SheetHeader>
          <SheetTitle>任务产物</SheetTitle>
          <SheetDescription>{artifacts.length} 个已验证文件</SheetDescription>
        </SheetHeader>
        <Tabs
          value={tab}
          onValueChange={setTab}
          className="min-h-0 px-4 pb-4"
        >
          <TabsList>
            <TabsTrigger value="list">文件</TabsTrigger>
            <TabsTrigger value="preview" disabled={selectedArtifact === undefined}>
              预览
            </TabsTrigger>
          </TabsList>
          <TabsContent value="list" className="min-h-0 overflow-y-auto">
            <AttachmentGroup className="flex-col overflow-x-visible">
              {artifacts.map((artifact) => {
                const { Icon, label } = fileType(
                  artifact.name,
                  artifact.role,
                );
                return (
                  <Attachment
                    key={artifact.artifact_id}
                    className="w-full flex-nowrap"
                  >
                    <AttachmentTrigger
                      aria-label={`预览 ${artifact.name}`}
                      onClick={() => {
                        setSelectedArtifactId(artifact.artifact_id);
                        setTab("preview");
                      }}
                    />
                    <AttachmentMedia>
                      <Icon aria-hidden="true" />
                    </AttachmentMedia>
                    <AttachmentContent>
                      <AttachmentTitle title={artifact.name}>
                        {artifact.name}
                      </AttachmentTitle>
                      <AttachmentDescription>
                        {label} · {formatSize(artifact.size)}
                      </AttachmentDescription>
                    </AttachmentContent>
                    <AttachmentActions>
                      <AttachmentAction
                        type="button"
                        onClick={() => downloadArtifact(artifact)}
                        aria-label={`下载 ${artifact.name}`}
                      >
                        <DownloadIcon aria-hidden="true" />
                      </AttachmentAction>
                    </AttachmentActions>
                  </Attachment>
                );
              })}
            </AttachmentGroup>
          </TabsContent>
          <TabsContent value="preview" className="min-h-0 overflow-y-auto">
            {selectedArtifact !== undefined && (
              <ResultsViewer
                taskId={taskId}
                artifacts={[selectedArtifact]}
                activities={[]}
              />
            )}
          </TabsContent>
        </Tabs>
        <div className="flex justify-end px-4 pb-4">
          <Button
            type="button"
            onClick={() => artifacts.forEach(downloadArtifact)}
            disabled={artifacts.length === 0}
          >
            <DownloadIcon data-icon="inline-start" aria-hidden="true" />
            保存全部产物
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
