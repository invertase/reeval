import { Link, Outlet } from '@tanstack/react-router'
import { Laptop, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLiveUpdates, useStudio } from '@/lib/data'
import { timeAgo } from '@/lib/format'
import { type Theme, useTheme } from '@/lib/theme'

function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Theme">
          {resolved === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          <DropdownMenuRadioItem value="light">
            <Sun className="size-4" /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="size-4" /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Laptop className="size-4" /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ModeBadge() {
  const { data } = useStudio()
  if (!data) return null
  if (data.mode === 'live') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-pass opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-pass" />
            </span>
            Live
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Watching the history folder: runs show here while they run, and stay once they land.
        </TooltipContent>
      </Tooltip>
    )
  }
  return (
    <span className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">
      Snapshot · {timeAgo(data.generatedAt)}
    </span>
  )
}

export function Shell() {
  const { data: studio } = useStudio()
  useLiveUpdates(!!studio?.features.live)
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
            <span className="flex size-7 items-center justify-center rounded-lg bg-brand text-white shadow-sm">
              <svg viewBox="0 0 32 32" className="size-5" aria-hidden="true">
                <path
                  d="M7 22 13.5 9l3.8 7.6L19.6 13 25 22"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="hidden sm:inline">reeval Studio</span>
          </Link>
          {studio ? (
            <span className="hidden truncate font-mono text-xs text-muted-foreground md:inline">
              {studio.project}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <ModeBadge />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  )
}
