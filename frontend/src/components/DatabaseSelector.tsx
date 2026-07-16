import { useMemo } from "react"
import { useAgentStore } from "@/stores/agentStore"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"

interface DatabaseSelectorProps {
  /** Optional callback when a database is toggled. */
  onToggle?: (id: string, selected: boolean) => void
  disabled?: boolean
}

type CategoryKey = "discovery" | "acquisition" | "processing"

const CATEGORY_CONFIG: Record<
  CategoryKey,
  { label: string; variant: "secondary" | "outline" | "ghost" }
> = {
  discovery: {
    label: "发现",
    variant: "secondary",
  },
  acquisition: {
    label: "采集",
    variant: "outline",
  },
  processing: {
    label: "处理",
    variant: "ghost",
  },
}

function resolveCategory(
  category: string,
): { label: string; variant: "secondary" | "outline" | "ghost" } {
  return (
    CATEGORY_CONFIG[category as CategoryKey] ?? {
      label: category,
      variant: "outline",
    }
  )
}

export function DatabaseSelector({ onToggle, disabled = false }: DatabaseSelectorProps) {
  const databases = useAgentStore((s) => s.databases)
  const selectedDatabases = useAgentStore((s) => s.draft.selectedDatabaseIds)
  const setSelectedDatabases = useAgentStore((s) => s.setDraftSelectedDatabaseIds)

  // Group databases by category, preserving insertion order.
  const grouped = useMemo(() => {
    const map = new Map<string, typeof databases>()
    for (const db of databases) {
      const list = map.get(db.category) ?? []
      list.push(db)
      map.set(db.category, list)
    }
    return Array.from(map.entries())
  }, [databases])

  const allSelected =
    databases.length > 0 && selectedDatabases.length === databases.length

  const handleValueChange = (ids: string[]) => {
    setSelectedDatabases(ids)
    if (onToggle) {
      const added = ids.filter((id) => !selectedDatabases.includes(id))
      const removed = selectedDatabases.filter((id) => !ids.includes(id))
      for (const id of added) onToggle(id, true)
      for (const id of removed) onToggle(id, false)
    }
  }

  const handleToggleAll = () => {
    handleValueChange(allSelected ? [] : databases.map((database) => database.id))
  }

  // ── Empty state ──────────────────────────────────────────────
  if (databases.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        暂无可用数据源
      </div>
    )
  }

  // ── Populated state ──────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      {/* Header row: toggle-all button + selection count */}
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={handleToggleAll}
          disabled={disabled}
        >
          {allSelected ? "取消全选" : "全选"}
        </Button>
        <span className="text-xs text-muted-foreground">
          已选择 {selectedDatabases.length}/{databases.length}
        </span>
      </div>

      {/* Category-grouped toggle chips */}
      <ToggleGroup
        value={selectedDatabases}
        onValueChange={handleValueChange}
        multiple
        disabled={disabled}
        orientation="vertical"
        spacing={0}
        className="w-full"
      >
        {grouped.map(([category, dbs], groupIdx) => {
          const cfg = resolveCategory(category)

          return (
            <div key={category} className="flex flex-col gap-1 w-full">
              {groupIdx > 0 && <Separator className="my-1" />}

              {/* Category section header */}
              <span className="px-2 pt-1 text-[0.625rem] font-semibold text-muted-foreground">
                {cfg.label}
              </span>

              {dbs.map((db) => (
                <Tooltip key={db.id}>
                  <TooltipTrigger
                    render={<ToggleGroupItem
                      value={db.id}
                      variant="outline"
                      size="default"
                      className="w-full justify-between gap-2"
                    />}
                  >
                    <span className="truncate">{db.name}</span>
                    <Badge variant={cfg.variant}>
                      {cfg.label}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="left">{db.description}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          )
        })}
      </ToggleGroup>
    </div>
  )
}
