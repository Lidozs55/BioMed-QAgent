import { useSyncExternalStore } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CheckCircleIcon, InfoIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react"

import { Spinner } from "@/components/ui/spinner"

function subscribeToRootTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  })
  return () => observer.disconnect()
}

function rootTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useSyncExternalStore(
    subscribeToRootTheme,
    rootTheme,
    (): "light" => "light",
  )

  return (
    <Sonner
      theme={theme}
      position="bottom-center"
      className="toaster group"
      icons={{
        success: (
          <CheckCircleIcon />
        ),
        info: (
          <InfoIcon />
        ),
        warning: (
          <WarningIcon />
        ),
        error: (
          <XCircleIcon />
        ),
        loading: (
          <Spinner />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
