import { useState } from "react";
import {
  ArrowBendUpLeftIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

export interface QueuedMessage {
  id: string;
  input: string;
}

interface QueuedMessagesProps {
  entries: QueuedMessage[];
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  onSteer: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

/**
 * 待发送队列：显示在文本输入框上方。每条消息占一行，超出用省略号截断；
 * 左侧 2×3 圆点手柄可拖动排序，右侧提供调整方向 / 编辑 / 删除操作。
 */
export function QueuedMessages({
  entries,
  onDelete,
  onEdit,
  onSteer,
  onReorder,
}: QueuedMessagesProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const handleDrop = (targetId: string) => {
    if (draggingId === null || draggingId === targetId) {
      setDraggingId(null);
      return;
    }
    const from = entries.findIndex((entry) => entry.id === draggingId);
    const to = entries.findIndex((entry) => entry.id === targetId);
    if (from === -1 || to === -1) {
      setDraggingId(null);
      return;
    }
    onReorder(from, to);
    setDraggingId(null);
  };

  return (
    <div className="space-y-1.5" data-slot="queued-messages">
      {entries.map((entry) => (
        <div
          key={entry.id}
          draggable
          onDragStart={(event) => {
            setDraggingId(entry.id);
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = "move";
            }
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => handleDrop(entry.id)}
          onDragEnd={() => setDraggingId(null)}
          className={cn(
            "group flex items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5",
            draggingId === entry.id && "opacity-60",
          )}
        >
          <span
            className="grid shrink-0 cursor-grab grid-cols-3 gap-0.5"
            aria-hidden="true"
            title="拖动排序"
          >
            {Array.from({ length: 6 }).map((_, index) => (
              <span
                key={index}
                className="size-1 rounded-full bg-muted-foreground/50"
              />
            ))}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-sm text-foreground"
            title={entry.input}
          >
            {entry.input}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onSteer(entry.id)}
              aria-label={`调整方向：${entry.input}`}
              title="调整方向（取消当前回答并优先发送）"
            >
              <ArrowBendUpLeftIcon className="size-3.5" />
            </button>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onEdit(entry.id)}
              aria-label={`编辑：${entry.input}`}
              title="编辑"
            >
              <PencilSimpleIcon className="size-3.5" />
            </button>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
              onClick={() => onDelete(entry.id)}
              aria-label={`删除：${entry.input}`}
              title="删除"
            >
              <TrashIcon className="size-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
