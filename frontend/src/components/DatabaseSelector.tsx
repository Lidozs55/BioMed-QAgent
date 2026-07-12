"use client"

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
import { cn } from "@/lib/utils"

interface DatabaseSelectorProps {
  /** Optional callback when a database is toggled. */
  onToggle?: (id: string, selected: boolean) => void
}

type CategoryKey = "discovery" | "acquisition" | "processing"

const CATEGORY_CONFIG: Record<
  CategoryKey,
  { label: string; className: string }
> = {
  discovery: {
    label: "发现",
    className:
      "bg-blue-500/10 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400",
  },
  acquisition: {
    label: "采集",
    className:
      "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400",
  },
  processing: {
    label: "处理",
    className:
      "bg-amber-500/10 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400",
  },
}

function resolveCategory(
  category: string,
): { label: string; className: string } {
  return (
    CATEGORY_CONFIG[category as CategoryKey] ?? {
      label: category,
      className: "",
    }
  )
}

export function DatabaseSelector({ onToggle }: DatabaseSelectorProps) {
  const databases = useAgentStore((s) => s.databases)
  const selectedDatabases = useAgentStore((s) => s.selectedDatabases)
  const setSelectedDatabases = useAgentStore((s) => s.setSelectedDatabases)

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
    if (allSelected) {
      setSelectedDatabases([])
    } else {
      setSelectedDatabases(databases.map((d) => d.id))
    }
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
        <Button variant="outline" size="sm" onClick={handleToggleAll}>
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
              <span className="px-2 pt-1 text-[0.625rem] font-semibold text-muted-foreground uppercase tracking-wider">
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
                    <Badge
                      variant="outline"
                      className={cn(
                        "shrink-0 text-[0.625rem] h-5 px-1.5",
                        cfg.className,
                      )}
                    >
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
