import { useThemeStore } from "@/stores/themeStore"

export type Theme = "light" | "dark"

export function useTheme() {
  const theme = useThemeStore((state) => state.resolved)
  const toggleTheme = useThemeStore((state) => state.toggleTheme)
  return { theme, toggleTheme } as const
}
