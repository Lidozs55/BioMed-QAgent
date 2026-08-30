import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";

import { getSettingsNavGroup } from "@/components/settings/settingsNavConfig";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
} from "@/components/ui/popover";
import { searchSettingsIndex, type SettingsIndexEntry } from "@/lib/settingsIndex";
import { cn } from "@/lib/utils";

export interface SettingsSearchProps {
  onNavigate: (section: string, anchor: string) => void;
  className?: string;
}

export function SettingsSearch({ onNavigate, className }: SettingsSearchProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchSettingsIndex(query), [query]);
  const hasQuery = query.trim().length > 0;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(hasQuery);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasQuery]);

  useLayoutEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const selectResult = (entry: SettingsIndexEntry) => {
    onNavigate(entry.section, entry.anchor);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = results[activeIndex];
      if (entry) selectResult(entry);
    } else if (event.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => setOpen(nextOpen && hasQuery)}
      modal={false}
    >
      <div className={cn("relative", className)}>
        <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          id="settings-search"
          type="text"
          value={query}
          placeholder="搜索设置..."
          aria-label="搜索设置"
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setOpen(event.target.value.trim().length > 0);
          }}
          onFocus={() => setOpen(hasQuery)}
          onKeyDown={handleInputKeyDown}
          className="h-8 pr-7 pl-8"
        />
        {query && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="清空搜索"
            className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            <XIcon aria-hidden="true" />
          </Button>
        )}
      </div>
      <PopoverContent
        align="start"
        anchor={inputRef}
        className="w-[min(26rem,var(--available-width))] p-1!"
        initialFocus={false}
      >
        {hasQuery &&
          (results.length === 0 ? (
            <div className="px-3 py-2.5 text-xs text-muted-foreground">无匹配项</div>
          ) : (
            <ul role="listbox" aria-label="设置搜索结果" className="max-h-80 overflow-y-auto p-1">
              {results.map((entry, index) => {
                const group = getSettingsNavGroup(entry.section);
                return (
                  <li key={entry.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      role="option"
                      aria-selected={index === activeIndex}
                      className={cn(
                        "h-auto min-h-0 w-full items-baseline justify-between rounded-md px-2.5 py-2 text-left text-xs font-normal",
                        index === activeIndex
                          ? "bg-accent text-accent-foreground hover:bg-accent"
                          : "hover:bg-muted",
                      )}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectResult(entry)}
                    >
                      <span className="min-w-0 truncate text-sm font-medium">{entry.title}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {group?.label ?? entry.section} › {entry.section}
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          ))}
      </PopoverContent>
    </Popover>
  );
}
