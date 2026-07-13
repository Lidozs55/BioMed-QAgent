import { useTheme } from "@/hooks/useTheme"
import { Button } from "@/components/ui/button"
import { MoonIcon, SunIcon } from "@phosphor-icons/react"

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label="Toggle theme"
    >
      {theme === "dark" ? (
        <SunIcon data-icon="inline-start" />
      ) : (
        <MoonIcon data-icon="inline-start" />
      )}
    </Button>
  )
}
