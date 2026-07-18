import { useMemo, useRef, useState } from "react"
import { CheckIcon, DatabaseIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from "@/components/ui/combobox"
import { useAgentStore } from "@/stores/agentStore"

interface DatabaseSelectorProps {
  onToggle?: (id: string, selected: boolean) => void
  disabled?: boolean
}

const CATEGORY_LABELS: Record<string, string> = {
  discovery: "发现",
  acquisition: "采集",
  processing: "处理",
}

export function DatabaseSelector({
  onToggle,
  disabled = false,
}: DatabaseSelectorProps) {
  const databases = useAgentStore((state) => state.databases)
  const selectedIds = useAgentStore(
    (state) => state.draft.selectedDatabaseIds,
  )
  const setSelectedIds = useAgentStore(
    (state) => state.setDraftSelectedDatabaseIds,
  )
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const grouped = useMemo(() => {
    const groups = new Map<string, typeof databases>()
    for (const database of databases) {
      groups.set(database.category, [
        ...(groups.get(database.category) ?? []),
        database,
      ])
    }
    return Array.from(groups, ([category, items]) => ({ category, items }))
  }, [databases])

  const selected = databases.filter((database) =>
    selectedIds.includes(database.id),
  )
  const allSelected =
    databases.length > 0 && selected.length === databases.length

  const commit = (nextIds: string[]) => {
    setSelectedIds(nextIds)
    for (const id of nextIds.filter((id) => !selectedIds.includes(id))) {
      onToggle?.(id, true)
    }
    for (const id of selectedIds.filter((id) => !nextIds.includes(id))) {
      onToggle?.(id, false)
    }
  }

  return (
    <Combobox
      items={grouped.map((group) => ({
        value: group.category,
        items: group.items,
      }))}
      multiple
      value={selected}
      onValueChange={(items) => commit(items.map((item) => item.id))}
      itemToStringLabel={(item) => item.name}
      itemToStringValue={(item) => item.id}
      isItemEqualToValue={(item, value) => item.id === value.id}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled || databases.length === 0}
    >
      <ComboboxTrigger
        ref={triggerRef}
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 px-2 text-muted-foreground"
            aria-label={`选择数据源，已选择 ${selected.length} 个`}
          />
        }
      >
        <DatabaseIcon aria-hidden="true" />
        <span>
          {selected.length === 0 ? "数据源" : `${selected.length} 个数据源`}
        </span>
      </ComboboxTrigger>
      <ComboboxContent
        anchor={triggerRef}
        side="top"
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)]"
      >
        <ComboboxInput
          aria-label="搜索数据源"
          placeholder="搜索数据源..."
          showClear
        />
        <div className="p-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() =>
              commit(
                allSelected ? [] : databases.map((database) => database.id),
              )
            }
          >
            <span className="flex size-4 items-center justify-center rounded border">
              {allSelected && <CheckIcon aria-hidden="true" />}
            </span>
            {allSelected ? "清空全部" : "选择全部"}
          </Button>
        </div>
        <ComboboxSeparator />
        <ComboboxEmpty>未找到匹配的数据源</ComboboxEmpty>
        <ComboboxList>
          {grouped.map((group) => (
            <ComboboxGroup key={group.category} items={group.items}>
              <ComboboxLabel>
                {CATEGORY_LABELS[group.category] ?? group.category}
              </ComboboxLabel>
              <ComboboxCollection>
                {(database) => (
                  <ComboboxItem key={database.id} value={database}>
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {database.name}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {database.description}
                      </div>
                    </div>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
