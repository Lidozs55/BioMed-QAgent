import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface DiffViewProps {
  /** 删除行(先渲染,edit 的 oldText / write 不传)。 */
  deleted?: string[];
  /** 新增行(edit 的 newText / write 的 content)。 */
  added: string[];
  className?: string;
  maxHeightClassName?: string;
}

type DiffLineKind = "deleted" | "added";

const LINE_CLASS: Record<DiffLineKind, string> = {
  deleted: "border-l-destructive bg-destructive/10",
  added: "border-l-success bg-success/10",
};

const MARK_CLASS: Record<DiffLineKind, string> = {
  deleted: "text-destructive/80",
  added: "text-success/80",
};

function DiffLine({ kind, text }: { kind: DiffLineKind; text: string }) {
  return (
    <div
      className={cn(
        "flex min-w-0 gap-1.5 border-l-2 py-px pr-2 pl-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap",
        LINE_CLASS[kind],
      )}
    >
      <span
        aria-hidden="true"
        className={cn("shrink-0 select-none", MARK_CLASS[kind])}
      >
        {kind === "deleted" ? "−" : "+"}
      </span>
      <span className="min-w-0">{text.length > 0 ? text : "\u00A0"}</span>
    </div>
  );
}

/** 行级 diff 视图:红删绿增,行前缀不可选中(复制只带代码)。 */
export function DiffView({
  deleted,
  added,
  className,
  maxHeightClassName = "max-h-72",
}: DiffViewProps) {
  return (
    <ScrollArea className={cn("rounded-md bg-muted/50", maxHeightClassName, className)}>
      <div className="py-1">
        {deleted?.map((line, index) => (
          <DiffLine key={`d-${index}`} kind="deleted" text={line} />
        ))}
        {added.map((line, index) => (
          <DiffLine key={`a-${index}`} kind="added" text={line} />
        ))}
      </div>
    </ScrollArea>
  );
}
