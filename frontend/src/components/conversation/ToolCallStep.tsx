import { useState, type ComponentType } from "react";

import { parseDynamicFamilyToolOutputText } from "@/lib/familyHost";
import { FamilyHostStatusCard } from "@/components/FamilyHostStatusCard";
import { Message, MessageContent } from "@/components/ui/message";
import type { DownloadControl, ToolCallItem } from "@/runtime/types";
import { DownloadProgress } from "./DownloadProgress";
import { BashTool } from "./tool-renderers/BashTool";
import { FileEditTool } from "./tool-renderers/FileEditTool";
import { FileReadTool } from "./tool-renderers/FileReadTool";
import { FileWriteTool } from "./tool-renderers/FileWriteTool";
import { GenericToolCall } from "./tool-renderers/GenericToolCall";
import type { ToolRendererProps } from "./tool-renderers/types";

/**
 * 内置编码工具的专用渲染器;其余工具走 GenericToolCall(中文标签 +
 * JSON 自动格式化)。未知未来工具自动落入通用路径。
 *
 * Pi 原生工具名为 read/write/edit/bash;服务端 workspace 沙箱工具名为
 * workspace_read/write/edit/exec(server/src/agent/workspace/tools.ts),
 * 参数形状兼容,共用同一组渲染器(workspace_exec 走 BashTool 的
 * { executable, args } 适配分支)。
 */
const DEDICATED_RENDERERS: Partial<
  Record<string, ComponentType<ToolRendererProps>>
> = {
  read: FileReadTool,
  write: FileWriteTool,
  edit: FileEditTool,
  bash: BashTool,
  workspace_read: FileReadTool,
  workspace_write: FileWriteTool,
  workspace_edit: FileEditTool,
  workspace_exec: BashTool,
};

interface ToolCallStepProps {
  item: ToolCallItem;
  /** Pause/resume controls forwarded to download tool calls. */
  downloadControl?: DownloadControl;
}

/**
 * 工具调用渲染入口:收起态一律为 Marker 行,点击展开对应卡片。
 *
 * 下载进度条保持在 Collapsible 之外——运行中即使收起也可见(既有契约),
 * 完成后仅在展开时显示。展开状态在本次提升,供渲染器与进度条共享。
 */
export function ToolCallStep({ item, downloadControl }: ToolCallStepProps) {
  const [expanded, setExpanded] = useState(false);
  const isDownload = item.progress?.kind === "downloaded_bytes";
  const dynamicFamilyOutput =
    item.toolName === "submit_dynamic_family_publication"
      ? parseDynamicFamilyToolOutputText(item.output)
      : null;
  const Renderer = DEDICATED_RENDERERS[item.toolName];

  return (
    <Message align="start">
      <MessageContent className="w-full">
        {Renderer ? (
          <Renderer item={item} open={expanded} onOpenChange={setExpanded} />
        ) : (
          <GenericToolCall item={item} open={expanded} onOpenChange={setExpanded} />
        )}
        {isDownload && item.progress != null && (item.status !== "completed" || expanded) && (
          <DownloadProgress
            status={item.status}
            progress={item.progress}
            control={downloadControl}
            resume={{
              runId: item.runId,
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              arguments: item.arguments,
            }}
            expanded={expanded}
          />
        )}
        {dynamicFamilyOutput !== null && <FamilyHostStatusCard output={dynamicFamilyOutput} />}
      </MessageContent>
    </Message>
  );
}
