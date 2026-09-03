import { CaretDownIcon, GlobeIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import type { SearchInfoItem } from "@/runtime/types";

interface SearchInfoStepProps {
  item: SearchInfoItem;
}

function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
}

/**
 * Provider-side web-search hits (Bailian 联网搜索) captured from the model
 * response. Display metadata only — visually distinct from Agent tool-call
 * steps, which are the sanctioned acquisition/evidence path.
 */
export function SearchInfoStep({ item }: SearchInfoStepProps) {
  const [open, setOpen] = useState(false);
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost" className="w-full">
          <BubbleContent className="w-full">
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              aria-expanded={open}
              className="flex w-full items-center gap-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <GlobeIcon className="size-4 shrink-0" aria-hidden="true" />
              <span>联网搜索来源（{item.results.length}）</span>
              <CaretDownIcon
                className={`ml-auto size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
            {open && (
              <ul className="mt-2 flex w-full flex-col gap-1 border-t pt-2">
                {item.results.map((result) => (
                  <li key={result.url} className="min-w-0 text-sm">
                    <a
                      href={result.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-muted-foreground transition-colors hover:text-foreground"
                      title={result.title ?? result.url}
                    >
                      <span className="text-foreground">{result.site_name !== "" ? result.site_name : displayHost(result.url)}</span>
                      <span className="mx-1.5 text-border">·</span>
                      <span>{displayHost(result.url)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
