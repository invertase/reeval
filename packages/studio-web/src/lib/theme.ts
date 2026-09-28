import { useCallback, useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const KEY = 'reeval-studio-theme'
const media = () => window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

const stored = (): Theme => {
  const value = localStorage.getItem(KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function applyTheme(theme: Theme = stored()) {
  const dark = theme === 'dark' || (theme === 'system' && media().matches)
  document.documentElement.classList.toggle('dark', dark)
}

export function initTheme() {
  applyTheme()
  media().addEventListener('change', () => {
    applyTheme()
    for (const l of listeners) l()
  })
}

export function useTheme() {
  const theme = useSyncExternalStore((l) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }, stored)
  const setTheme = useCallback((next: Theme) => {
    if (next === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
    applyTheme(next)
    for (const l of listeners) l()
  }, [])
  const resolved: 'light' | 'dark' =
    theme === 'system' ? (media().matches ? 'dark' : 'light') : theme
  return { theme, resolved, setTheme }
}
