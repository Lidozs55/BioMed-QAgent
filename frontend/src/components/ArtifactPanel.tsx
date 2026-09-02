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

export const ARTIFACT_LIST_TAB = "list";
export const ARTIFACT_PREVIEW_TAB = "preview";

interface ArtifactPanelProps {
  artifacts: readonly ArtifactProjection[];
  taskId: string;
  download?: DownloadArtifact;
}

/**
 * 正式任务产物的文件/预览双栏视图。从 ArtifactSheet 抽出，供统一
 * Assets 入口与旧 ArtifactSheet 共用；只展示已验证产物，不承载任何
 * 未准入（ua_*）内容。
 */
export function ArtifactPanel({
  artifacts,
  taskId,
  download = triggerArtifactDownload,
}: ArtifactPanelProps) {
  const { getArtifactUrl } = useAPI();
  const [tab, setTab] = useState(ARTIFACT_LIST_TAB);
  const [selectedArtifactId, setSelectedArtifactId] = useState(
    artifacts[0]?.artifact_id ?? null,
  );

  // 当前选择不在列表中时回退到首个产物（与原 ArtifactSheet 行为一致）。
  const selectedArtifact =
    artifacts.find((artifact) => artifact.artifact_id === selectedArtifactId) ??
    artifacts[0];

  const downloadArtifact = (artifact: ArtifactProjection) => {
    download(getArtifactUrl(taskId, artifact.artifact_id), artifact.name);
  };

  return (
    <Tabs value={tab} onValueChange={setTab} className="min-h-0 px-4 pb-4">
      <TabsList>
        <TabsTrigger value={ARTIFACT_LIST_TAB}>文件</TabsTrigger>
        <TabsTrigger
          value={ARTIFACT_PREVIEW_TAB}
          disabled={selectedArtifact === undefined}
        >
          预览
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value={ARTIFACT_LIST_TAB}
        className="min-h-0 overflow-y-auto"
      >
        <AttachmentGroup className="flex-col overflow-x-visible">
          {artifacts.map((artifact) => {
            const { Icon, label } = fileType(artifact.name, artifact.role);
            return (
              <Attachment
                key={artifact.artifact_id}
                className="w-full flex-nowrap"
              >
                <AttachmentTrigger
                  aria-label={`预览 ${artifact.name}`}
                  onClick={() => {
                    setSelectedArtifactId(artifact.artifact_id);
                    setTab(ARTIFACT_PREVIEW_TAB);
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
      <TabsContent
        value={ARTIFACT_PREVIEW_TAB}
        className="min-h-0 overflow-y-auto"
      >
        {selectedArtifact !== undefined && (
          <ResultsViewer
            taskId={taskId}
            artifacts={[selectedArtifact]}
            activities={[]}
          />
        )}
      </TabsContent>
    </Tabs>
  );
}

/** 保存全部产物按钮，与 ArtifactSheet 底部布局保持一致。 */
export function ArtifactSaveAllButton({
  artifacts,
  taskId,
  download = triggerArtifactDownload,
}: ArtifactPanelProps) {
  const { getArtifactUrl } = useAPI();
  return (
    <div className="flex justify-end px-4 pb-4">
      <Button
        type="button"
        onClick={() =>
          artifacts.forEach((artifact) =>
            download(
              getArtifactUrl(taskId, artifact.artifact_id),
              artifact.name,
            ),
          )
        }
        disabled={artifacts.length === 0}
      >
        <DownloadIcon data-icon="inline-start" aria-hidden="true" />
        保存全部产物
      </Button>
    </div>
  );
}
