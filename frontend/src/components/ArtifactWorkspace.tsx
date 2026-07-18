import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { DownloadIcon, FileIcon, SidebarSimpleIcon, XIcon } from "@phosphor-icons/react";

import ResultsViewer from "@/components/ResultsViewer";
import {
  artifactPanelEvents,
  toggleArtifactPanel,
} from "@/components/artifactPanelControl";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAPI } from "@/hooks/useAPI";
import { fileType, formatSize } from "@/lib/fileUtils";
import { selectActiveArtifacts, selectActiveTask } from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";

function ArtifactList({ onClose }: { onClose: () => void }) {
  const task = useAgentStore(selectActiveTask);
  const artifacts = useAgentStore(selectActiveArtifacts);
  const { getArtifactUrl } = useAPI();

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div>
          <h2 className="text-sm font-semibold">产物</h2>
          <p className="text-xs text-muted-foreground">{artifacts.length} 个文件</p>
        </div>
        <ArtifactPanelCloseButton onClose={onClose} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-3">
          {task === undefined || artifacts.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 text-center text-sm text-muted-foreground">
              <FileIcon className="size-5" aria-hidden="true" />
              <span>产物生成后会显示在这里</span>
            </div>
          ) : (
            artifacts.map((artifact) => {
              const { Icon, label } = fileType(artifact.name);
              const url = getArtifactUrl(task.summary.task_id, artifact.artifact_id);
              return (
                <Attachment key={artifact.artifact_id} className="w-full flex-nowrap">
                  <AttachmentMedia>
                    <Icon aria-hidden="true" />
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle title={artifact.name}>{artifact.name}</AttachmentTitle>
                    <AttachmentDescription>
                      {label} · {formatSize(artifact.size)}
                    </AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentActions className="pr-2">
                    <AttachmentAction
                      render={<a href={url} download={artifact.name} />}
                      nativeButton={false}
                      aria-label={`下载 ${artifact.name}`}
                    >
                      <DownloadIcon aria-hidden="true" />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              );
            })
          )}
        </div>
        {task !== undefined && artifacts.length > 0 && (
          <div className="border-t p-3">
            <ResultsViewer />
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function ArtifactPanelCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭产物面板">
      <XIcon aria-hidden="true" />
    </Button>
  );
}

export function ArtifactPanelToggle() {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={toggleArtifactPanel}
      aria-label="切换产物面板"
    >
      <SidebarSimpleIcon aria-hidden="true" />
    </Button>
  );
}

interface ArtifactWorkspaceProps {
  children: ReactNode;
}

export function ArtifactWorkspace({ children }: ArtifactWorkspaceProps) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((current) => !current), []);

  useEffect(() => {
    window.addEventListener(artifactPanelEvents.open, open);
    window.addEventListener(artifactPanelEvents.close, close);
    window.addEventListener(artifactPanelEvents.toggle, toggle);
    return () => {
      window.removeEventListener(artifactPanelEvents.open, open);
      window.removeEventListener(artifactPanelEvents.close, close);
      window.removeEventListener(artifactPanelEvents.toggle, toggle);
    };
  }, [close, open, toggle]);

  return (
    <div className="relative h-full min-h-0 min-w-0">
      {isOpen ? (
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="68%" minSize="42%">
            <div className="h-full min-h-0 min-w-0">{children}</div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="32%" minSize="18rem" maxSize="50%">
            <ArtifactList onClose={close} />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="h-full min-h-0 min-w-0">{children}</div>
      )}
    </div>
  );
}
